import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any
from uuid import uuid4

from azure.cosmos import CosmosClient, PartitionKey
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


class NoteCreate(BaseModel):
    owner: str = Field(min_length=2, max_length=80)
    title: str = Field(min_length=2, max_length=120)
    body: str = Field(min_length=1, max_length=2000)


class Note(BaseModel):
    id: str
    owner: str
    title: str
    body: str
    createdAt: str


def env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@lru_cache(maxsize=1)
def get_secret_client() -> SecretClient:
    return SecretClient(
        vault_url=env("KEY_VAULT_URL"),
        credential=DefaultAzureCredential(),
    )


@lru_cache(maxsize=1)
def get_cosmos_container() -> Any:
    secret_client = get_secret_client()
    endpoint = secret_client.get_secret(env("COSMOS_ENDPOINT_SECRET_NAME", "cosmos-endpoint")).value
    key = secret_client.get_secret(env("COSMOS_KEY_SECRET_NAME", "cosmos-key")).value

    database_name = env("COSMOS_DATABASE_NAME", "demoapp")
    container_name = env("COSMOS_CONTAINER_NAME", "notes")

    client = CosmosClient(endpoint, credential=key)
    database = client.create_database_if_not_exists(id=database_name)
    return database.create_container_if_not_exists(
        id=container_name,
        partition_key=PartitionKey(path="/owner"),
        offer_throughput=400,
    )


app = FastAPI(title="AKS Workload Identity Key Vault Demo")

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
    return {
        "database": env("COSMOS_DATABASE_NAME", "demoapp"),
        "container": env("COSMOS_CONTAINER_NAME", "notes"),
        "vaultHost": env("KEY_VAULT_URL").replace("https://", "").rstrip("/"),
    }


@app.get("/api/notes", response_model=list[Note])
def list_notes(owner: str = "demo-user") -> list[dict[str, Any]]:
    container = get_cosmos_container()
    return list(
        container.query_items(
            query="SELECT * FROM c WHERE c.owner = @owner ORDER BY c.createdAt DESC",
            parameters=[{"name": "@owner", "value": owner}],
            partition_key=owner,
        )
    )


@app.post("/api/notes", response_model=Note, status_code=201)
def create_note(note: NoteCreate) -> dict[str, Any]:
    item = {
        "id": str(uuid4()),
        "owner": note.owner,
        "title": note.title,
        "body": note.body,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    return get_cosmos_container().create_item(body=item)


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: str, owner: str) -> None:
    try:
        get_cosmos_container().delete_item(item=note_id, partition_key=owner)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Note not found") from exc
