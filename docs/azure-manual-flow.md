# Manual Azure Deployment Flow

This guide creates the Azure resources needed for the app:

- Resource group
- Cosmos DB for NoSQL with public access for demo
- Key Vault containing the Cosmos DB endpoint and key
- AKS with OIDC issuer and Workload Identity
- User-assigned managed identity
- Federated identity credential between AKS and the Kubernetes service account

Use Azure CLI for exact values, then verify the same choices in the Azure Portal if you are doing the flow manually.

## Optional: Test The App Locally First

If you want to test the landing page, register, sign-in, and notes workflow before creating Azure resources, use Docker Compose from the project root:

```powershell
docker compose up --build
```

Open `http://localhost:3000`.

This local test uses `APP_STORAGE_MODE=local`, so it does not call Azure Key Vault or Cosmos DB. Users and notes are saved in a local Docker volume. Reset local data with:

```powershell
docker compose down -v
```

Do not use `APP_STORAGE_MODE=local` for AKS. The AKS deployment should use Key Vault secrets and Cosmos DB as shown below.

## 1. Choose Names

```powershell
$SUBSCRIPTION_ID="<subscription-id>"
$LOCATION="eastus"
$RG="rg-aks-keyvault-demo"
$AKS_NAME="aks-keyvault-demo"
$KV_NAME="kv-demo-$((Get-Random -Maximum 9999))"
$COSMOS_NAME="cosmos-kv-demo-$((Get-Random -Maximum 9999))"
$IDENTITY_NAME="id-keyvault-demo"
$NAMESPACE="keyvault-demo"
$SERVICE_ACCOUNT="keyvault-demo-sa"
$DOCKERHUB_NAMESPACE="elzabeth03"
$IMAGE_NAME="keyvault-demo"
$IMAGE_TAG="1.0.0"
```

```powershell
az account set --subscription $SUBSCRIPTION_ID
az group create --name $RG --location $LOCATION
```

Portal options:

- Subscription: choose your active subscription
- Resource group: create `rg-aks-keyvault-demo`
- Region: use one region for all resources, such as East US

## 2. Create Cosmos DB For NoSQL

```powershell
az cosmosdb create `
  --resource-group $RG `
  --name $COSMOS_NAME `
  --locations regionName=$LOCATION failoverPriority=0 isZoneRedundant=False `
  --public-network-access Enabled

az cosmosdb sql database create `
  --resource-group $RG `
  --account-name $COSMOS_NAME `
  --name demoapp

az cosmosdb sql container create `
  --resource-group $RG `
  --account-name $COSMOS_NAME `
  --database-name demoapp `
  --name notes `
  --partition-key-path "/owner" `
  --throughput 400

az cosmosdb sql container create `
  --resource-group $RG `
  --account-name $COSMOS_NAME `
  --database-name demoapp `
  --name users `
  --partition-key-path "/email" `
  --throughput 400
```

Portal options:

- API: Azure Cosmos DB for NoSQL
- Capacity mode: Provisioned throughput
- Apply free tier discount: optional, select if available
- Limit total account throughput: optional for demo
- Networking: Public access from all networks for demo
- Disable local authentication: No, because this demo stores the key in Key Vault

Production note: prefer private endpoints, firewall rules, and managed identity/RBAC where possible.

## 3. Create Key Vault

```powershell
az keyvault create `
  --resource-group $RG `
  --name $KV_NAME `
  --location $LOCATION `
  --enable-rbac-authorization true
```

Portal options:

- Permission model: Azure role-based access control
- Public network access: Enabled for demo
- Soft-delete: Enabled
- Purge protection: optional for demo, recommended for production

Store Cosmos values as secrets:

```powershell
$COSMOS_ENDPOINT=$(az cosmosdb show --resource-group $RG --name $COSMOS_NAME --query documentEndpoint -o tsv)
$COSMOS_KEY=$(az cosmosdb keys list --resource-group $RG --name $COSMOS_NAME --type keys --query primaryMasterKey -o tsv)
$JWT_SECRET_BYTES=New-Object byte[] 64
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($JWT_SECRET_BYTES)
$JWT_SECRET=[Convert]::ToBase64String($JWT_SECRET_BYTES)

az keyvault secret set --vault-name $KV_NAME --name cosmos-endpoint --value $COSMOS_ENDPOINT
az keyvault secret set --vault-name $KV_NAME --name cosmos-key --value $COSMOS_KEY
az keyvault secret set --vault-name $KV_NAME --name auth-jwt-secret --value $JWT_SECRET
```

Authentication secret reminder:

- Create `auth-jwt-secret` before deploying the application.
- Keep `cosmos-endpoint`, `cosmos-key`, and `auth-jwt-secret` in Key Vault. Do not put their raw values in Kubernetes manifests.
- If you later add other secrets, such as external API keys, OAuth client secrets, or webhook signing secrets, add them to Key Vault with `az keyvault secret set --vault-name $KV_NAME --name <secret-name> --value <secret-value>` and add the corresponding secret-name environment variable to the deployment.

## 4. Create AKS With OIDC And Workload Identity

```powershell
az aks create `
  --resource-group $RG `
  --name $AKS_NAME `
  --node-count 2 `
  --enable-oidc-issuer `
  --enable-workload-identity `
  --generate-ssh-keys

az aks get-credentials --resource-group $RG --name $AKS_NAME
```

Portal options:

- Authentication and Authorization: local accounts can stay enabled for demo
- Node pools: 2 nodes is enough
- Integrations: no Azure Container Registry attachment is required when using public Docker Hub images
- Security: enable OIDC issuer
- Security: enable Workload Identity
- Networking: Azure CNI or Kubenet are both fine for demo

## 5. Create The User-Assigned Managed Identity

```powershell
az identity create `
  --resource-group $RG `
  --name $IDENTITY_NAME `
  --location $LOCATION

$IDENTITY_CLIENT_ID=$(az identity show --resource-group $RG --name $IDENTITY_NAME --query clientId -o tsv)
$IDENTITY_PRINCIPAL_ID=$(az identity show --resource-group $RG --name $IDENTITY_NAME --query principalId -o tsv)
```

This identity is the Entra ID object your pod will use. You do not need a classic App Registration for this workload identity flow; Azure creates and manages the service principal behind the user-assigned managed identity.

## 6. Grant Key Vault Access

```powershell
$KV_SCOPE=$(az keyvault show --resource-group $RG --name $KV_NAME --query id -o tsv)

az role assignment create `
  --assignee-object-id $IDENTITY_PRINCIPAL_ID `
  --assignee-principal-type ServicePrincipal `
  --role "Key Vault Secrets User" `
  --scope $KV_SCOPE
```

Portal options:

- Key Vault > Access control IAM > Add role assignment
- Role: Key Vault Secrets User
- Assign access to: Managed identity
- Managed identity type: User-assigned managed identity
- Select: the application workload identity `id-keyvault-demo`

Do not select the AKS agent pool identity, such as `aks-keyvault-demo-agentpool`. The app pod reads Key Vault through the user-assigned managed identity, not through the node pool identity.

## 7. Configure Federated Identity Credential

Get the AKS OIDC issuer URL:

```powershell
$OIDC_ISSUER=$(az aks show --resource-group $RG --name $AKS_NAME --query oidcIssuerProfile.issuerUrl -o tsv)
```

Create the federation:

```powershell
az identity federated-credential create `
  --resource-group $RG `
  --identity-name $IDENTITY_NAME `
  --name fic-keyvault-demo `
  --issuer $OIDC_ISSUER `
  --subject "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}" `
  --audience "api://AzureADTokenExchange"
```

Portal options:

- Managed Identity > Federated credentials > Add credential
- Federated credential scenario: Kubernetes accessing Azure resources
- Cluster issuer URL: the AKS OIDC issuer URL
- Namespace: `keyvault-demo`
- Service account: `keyvault-demo-sa`
- Audience: `api://AzureADTokenExchange`

## 8. Build And Push The Image To Docker Hub

```powershell
docker login
docker build -t "${DOCKERHUB_NAMESPACE}/${IMAGE_NAME}:${IMAGE_TAG}" .
docker push "${DOCKERHUB_NAMESPACE}/${IMAGE_NAME}:${IMAGE_TAG}"
```

This guide uses:

```text
elzabeth03/keyvault-demo:1.0.0
```

The Docker Hub repository must exist or your Docker Hub account must be allowed to create it on first push. If the repository is private, create a Kubernetes image pull secret before deploying and reference it from the deployment.

## 9. Update Kubernetes Manifests

Edit `k8s/service-account.yaml`:

```yaml
azure.workload.identity/client-id: "<IDENTITY_CLIENT_ID>"
```

Edit `k8s/deployment.yaml`:

```yaml
image: elzabeth03/keyvault-demo:1.0.0
KEY_VAULT_URL: "https://<KEY_VAULT_NAME>.vault.azure.net/"
JWT_SECRET_NAME: "auth-jwt-secret"
USERS_CONTAINER_NAME: "users"
```

## 10. Deploy

```powershell
kubectl apply -k k8s
kubectl rollout status deployment/keyvault-demo -n keyvault-demo
kubectl get svc keyvault-demo -n keyvault-demo
```

Open the external IP shown for the LoadBalancer service.

## 11. Validate Workload Identity

```powershell
kubectl logs deploy/keyvault-demo -n keyvault-demo
kubectl describe pod -l app=keyvault-demo -n keyvault-demo
```

Expected behavior:

- The pod has projected Azure identity token environment variables.
- The app can read `cosmos-endpoint` and `cosmos-key` from Key Vault.
- The app can read `auth-jwt-secret` from Key Vault to sign and verify sessions.
- Registering creates a user in the `users` Cosmos DB container.
- Creating a note writes an item to Cosmos DB for the signed-in account.

## Entra ID Configuration Summary

Use a user-assigned managed identity, not a manually created App Registration, for this demo.

The required Entra-related configuration is:

- User-assigned managed identity: `id-keyvault-demo`
- Key Vault role assignment: `Key Vault Secrets User`
- Federated credential on the managed identity
- Subject: `system:serviceaccount:keyvault-demo:keyvault-demo-sa`
- Audience: `api://AzureADTokenExchange`
- Kubernetes service account annotation: `azure.workload.identity/client-id`

## Cleanup

```powershell
az group delete --name $RG --yes --no-wait
```
