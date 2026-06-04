# AKS Key Vault Workload Identity Demo

This demo is a monolithic app with:

- FastAPI backend using Azure SDK
- Next.js frontend
- Azure Key Vault for Cosmos DB endpoint and key
- Azure Cosmos DB for NoSQL data storage
- AKS with OIDC issuer and Azure Workload Identity
- Docker and Kubernetes manifests

The use case is a small notes app. The frontend calls FastAPI APIs, FastAPI uses `DefaultAzureCredential`, Workload Identity provides the pod identity in AKS, and Key Vault returns the Cosmos DB credentials.

## Project Structure

```text
backend/                 FastAPI API
frontend/                Next.js UI
k8s/                     AKS manifests
docs/azure-manual-flow.md Manual Azure setup guide
Dockerfile               Monolithic production image
start.sh                 Starts FastAPI and Next.js in one container
```

## Local Development

For local development you can authenticate with Azure CLI and use the same Key Vault flow.

```powershell
az login
$env:KEY_VAULT_URL="https://<KEY_VAULT_NAME>.vault.azure.net/"
$env:COSMOS_ENDPOINT_SECRET_NAME="cosmos-endpoint"
$env:COSMOS_KEY_SECRET_NAME="cosmos-key"
```

Run the API:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Run the UI:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

## Container Build

```powershell
docker build -t keyvault-demo:1.0.0 .
```

For AKS, tag and push it to Azure Container Registry:

```powershell
docker tag keyvault-demo:1.0.0 <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
docker push <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
```

## Deploy To AKS

Replace placeholders in:

- `k8s/service-account.yaml`
- `k8s/deployment.yaml`

Then apply:

```powershell
kubectl apply -k k8s
kubectl get pods -n keyvault-demo
kubectl get svc -n keyvault-demo
```

Guides:

- GUI-first Azure Portal flow: [docs/azure-portal-gui-flow.md](docs/azure-portal-gui-flow.md)
- CLI-assisted manual flow: [docs/azure-manual-flow.md](docs/azure-manual-flow.md)
- Architecture and decision rationale: [docs/architecture-and-decision-rationale.md](docs/architecture-and-decision-rationale.md)
