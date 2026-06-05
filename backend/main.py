import base64
import hashlib
import hmac
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field


JWT_ALGORITHM = "HS256"
TOKEN_TTL_MINUTES = 60 * 8
PASSWORD_ITERATIONS = 260000
LOCAL_DATA_LOCK = threading.Lock()


class UserRegister(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class UserPublic(BaseModel):
    id: str
    name: str
    email: EmailStr


class AuthResponse(BaseModel):
    token: str
    user: UserPublic


class NoteCreate(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    body: str = Field(min_length=1, max_length=2000)


class Note(BaseModel):
    id: str
    owner: str
    title: str
    body: str
    createdAt: str


class LocalContainer:
    def __init__(self, name: str):
        self.name = name

    def _data_path(self) -> Path:
        return Path(os.getenv("LOCAL_DATA_FILE", "/tmp/vaultdesk-local.json"))

    def _read_store(self) -> dict[str, dict[str, Any]]:
        path = self._data_path()
        if not path.exists():
            return {"users": {}, "notes": {}}
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_store(self, store: dict[str, dict[str, Any]]) -> None:
        path = self._data_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(store, indent=2), encoding="utf-8")

    def read_item(self, item: str, partition_key: str) -> dict[str, Any]:
        with LOCAL_DATA_LOCK:
            value = self._read_store().get(self.name, {}).get(item)
        if value is None:
            raise CosmosResourceNotFoundError(message="Local item not found")
        return value

    def create_item(self, body: dict[str, Any]) -> dict[str, Any]:
        with LOCAL_DATA_LOCK:
            store = self._read_store()
            container = store.setdefault(self.name, {})
            if body["id"] in container:
                raise ValueError("Local item already exists")
            container[body["id"]] = body
            self._write_store(store)
        return body

    def query_items(self, query: str, parameters: list[dict[str, Any]], partition_key: str) -> list[dict[str, Any]]:
        owner = next((parameter["value"] for parameter in parameters if parameter["name"] == "@owner"), partition_key)
        with LOCAL_DATA_LOCK:
            items = list(self._read_store().get(self.name, {}).values())
        return sorted(
            [item for item in items if item.get("owner") == owner],
            key=lambda item: item.get("createdAt", ""),
            reverse=True,
        )

    def delete_item(self, item: str, partition_key: str) -> None:
        with LOCAL_DATA_LOCK:
            store = self._read_store()
            container = store.setdefault(self.name, {})
            if item not in container:
                raise CosmosResourceNotFoundError(message="Local item not found")
            del container[item]
            self._write_store(store)


def env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def local_mode() -> bool:
    return os.getenv("APP_STORAGE_MODE", "").lower() == "local"


@lru_cache(maxsize=1)
def get_secret_client() -> SecretClient:
    return SecretClient(
        vault_url=env("KEY_VAULT_URL"),
        credential=DefaultAzureCredential(),
    )


@lru_cache(maxsize=1)
def get_cosmos_database() -> Any:
    secret_client = get_secret_client()
    endpoint = secret_client.get_secret(env("COSMOS_ENDPOINT_SECRET_NAME", "cosmos-endpoint")).value
    key = secret_client.get_secret(env("COSMOS_KEY_SECRET_NAME", "cosmos-key")).value

    client = CosmosClient(endpoint, credential=key)
    return client.create_database_if_not_exists(id=env("COSMOS_DATABASE_NAME", "demoapp"))


@lru_cache(maxsize=1)
def get_notes_container() -> Any:
    if local_mode():
        return LocalContainer("notes")

    return get_cosmos_database().create_container_if_not_exists(
        id=env("COSMOS_CONTAINER_NAME", "notes"),
        partition_key=PartitionKey(path="/owner"),
        offer_throughput=400,
    )


@lru_cache(maxsize=1)
def get_users_container() -> Any:
    if local_mode():
        return LocalContainer("users")

    return get_cosmos_database().create_container_if_not_exists(
        id=env("USERS_CONTAINER_NAME", "users"),
        partition_key=PartitionKey(path="/email"),
        offer_throughput=400,
    )


@lru_cache(maxsize=1)
def get_jwt_secret() -> str:
    if local_mode():
        return env("LOCAL_JWT_SECRET", "local-only-development-jwt-secret-change-me")

    return get_secret_client().get_secret(env("JWT_SECRET_NAME", "auth-jwt-secret")).value


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str, salt: str | None = None) -> str:
    salt_bytes = b64url_decode(salt) if salt else os.urandom(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${b64url_encode(salt_bytes)}${b64url_encode(derived)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, expected = stored_hash.split("$", 3)
    except ValueError:
        return False

    try:
        iteration_count = int(iterations)
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256" or iteration_count != PASSWORD_ITERATIONS:
        return False

    actual = hash_password(password, salt).split("$", 3)[3]
    return hmac.compare_digest(actual, expected)


def create_token(user: dict[str, Any]) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user["id"],
        "email": user["email"],
        "name": user["name"],
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=TOKEN_TTL_MINUTES)).timestamp()),
    }
    header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
    encoded_header = b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    encoded_payload = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(get_jwt_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{b64url_encode(signature)}"


def read_token(token: str) -> dict[str, Any]:
    try:
        encoded_header, encoded_payload, encoded_signature = token.split(".", 2)
        signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
        expected_signature = hmac.new(get_jwt_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
        if not hmac.compare_digest(b64url_decode(encoded_signature), expected_signature):
            raise ValueError("Invalid signature")
        payload = json.loads(b64url_decode(encoded_payload))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication token") from exc

    if int(payload.get("exp", 0)) < int(datetime.now(timezone.utc).timestamp()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication token has expired")

    return payload


def current_user(authorization: str = Header(default="")) -> dict[str, Any]:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication is required")

    payload = read_token(token)
    try:
        return get_users_container().read_item(item=payload["sub"], partition_key=payload["email"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User no longer exists") from exc


def public_user(user: dict[str, Any]) -> dict[str, str]:
    return {"id": user["id"], "name": user["name"], "email": user["email"]}


app = FastAPI(title="AKS Workload Identity Key Vault App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def config() -> dict[str, str]:
    if local_mode():
        return {
            "database": env("COSMOS_DATABASE_NAME", "localdb"),
            "container": env("COSMOS_CONTAINER_NAME", "notes"),
            "vaultHost": "local-development",
        }

    return {
        "database": env("COSMOS_DATABASE_NAME", "demoapp"),
        "container": env("COSMOS_CONTAINER_NAME", "notes"),
        "vaultHost": env("KEY_VAULT_URL").replace("https://", "").rstrip("/"),
    }


@app.post("/api/auth/register", response_model=AuthResponse, status_code=201)
def register(payload: UserRegister) -> dict[str, Any]:
    email = payload.email.lower()
    users = get_users_container()

    try:
        users.read_item(item=email, partition_key=email)
    except CosmosResourceNotFoundError:
        user = {
            "id": email,
            "email": email,
            "name": payload.name.strip(),
            "passwordHash": hash_password(payload.password),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        users.create_item(body=user)
        return {"token": create_token(user), "user": public_user(user)}

    raise HTTPException(status_code=409, detail="An account with this email already exists")


@app.post("/api/auth/signin", response_model=AuthResponse)
def signin(payload: UserLogin) -> dict[str, Any]:
    email = payload.email.lower()
    try:
        user = get_users_container().read_item(item=email, partition_key=email)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid email or password") from exc

    if not verify_password(payload.password, user.get("passwordHash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    return {"token": create_token(user), "user": public_user(user)}


@app.get("/api/auth/me", response_model=UserPublic)
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, str]:
    return public_user(user)


@app.get("/api/notes", response_model=list[Note])
def list_notes(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    container = get_notes_container()
    return list(
        container.query_items(
            query="SELECT * FROM c WHERE c.owner = @owner ORDER BY c.createdAt DESC",
            parameters=[{"name": "@owner", "value": user["id"]}],
            partition_key=user["id"],
        )
    )


@app.post("/api/notes", response_model=Note, status_code=201)
def create_note(note: NoteCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = {
        "id": str(uuid4()),
        "owner": user["id"],
        "title": note.title,
        "body": note.body,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    return get_notes_container().create_item(body=item)


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: str, user: dict[str, Any] = Depends(current_user)) -> None:
    try:
        get_notes_container().delete_item(item=note_id, partition_key=user["id"])
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Note not found") from exc
