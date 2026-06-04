# Manual Azure Deployment Flow

This guide creates the Azure resources needed for the demo app:

- Resource group
- Azure Container Registry
- Cosmos DB for NoSQL with public access for demo
- Key Vault containing the Cosmos DB endpoint and key
- AKS with OIDC issuer and Workload Identity
- User-assigned managed identity
- Federated identity credential between AKS and the Kubernetes service account

Use Azure CLI for exact values, then verify the same choices in the Azure Portal if you are doing the flow manually.

## 1. Choose Names

```powershell
$SUBSCRIPTION_ID="<subscription-id>"
$LOCATION="eastus"
$RG="rg-aks-keyvault-demo"
$ACR_NAME="acrkvdemo$((Get-Random -Maximum 9999))"
$AKS_NAME="aks-keyvault-demo"
$KV_NAME="kv-demo-$((Get-Random -Maximum 9999))"
$COSMOS_NAME="cosmos-kv-demo-$((Get-Random -Maximum 9999))"
$IDENTITY_NAME="id-keyvault-demo"
$NAMESPACE="keyvault-demo"
$SERVICE_ACCOUNT="keyvault-demo-sa"
```

```powershell
az account set --subscription $SUBSCRIPTION_ID
az group create --name $RG --location $LOCATION
```

Portal options:

- Subscription: choose your active subscription
- Resource group: create `rg-aks-keyvault-demo`
- Region: use one region for all resources, such as East US

## 2. Create Azure Container Registry

```powershell
az acr create `
  --resource-group $RG `
  --name $ACR_NAME `
  --sku Basic `
  --admin-enabled false
```

Portal options:

- SKU: Basic is enough for demo
- Admin user: Disabled
- Networking: Public endpoint enabled

## 3. Create Cosmos DB For NoSQL

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
```

Portal options:

- API: Azure Cosmos DB for NoSQL
- Capacity mode: Provisioned throughput
- Apply free tier discount: optional, select if available
- Limit total account throughput: optional for demo
- Networking: Public access from all networks for demo
- Disable local authentication: No, because this demo stores the key in Key Vault

Production note: prefer private endpoints, firewall rules, and managed identity/RBAC where possible.

## 4. Create Key Vault

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

az keyvault secret set --vault-name $KV_NAME --name cosmos-endpoint --value $COSMOS_ENDPOINT
az keyvault secret set --vault-name $KV_NAME --name cosmos-key --value $COSMOS_KEY
```

## 5. Create AKS With OIDC And Workload Identity

```powershell
az aks create `
  --resource-group $RG `
  --name $AKS_NAME `
  --node-count 2 `
  --enable-oidc-issuer `
  --enable-workload-identity `
  --attach-acr $ACR_NAME `
  --generate-ssh-keys

az aks get-credentials --resource-group $RG --name $AKS_NAME
```

Portal options:

- Authentication and Authorization: local accounts can stay enabled for demo
- Node pools: 2 nodes is enough
- Integrations: attach the ACR you created
- Security: enable OIDC issuer
- Security: enable Workload Identity
- Networking: Azure CNI or Kubenet are both fine for demo

## 6. Create The User-Assigned Managed Identity

```powershell
az identity create `
  --resource-group $RG `
  --name $IDENTITY_NAME `
  --location $LOCATION

$IDENTITY_CLIENT_ID=$(az identity show --resource-group $RG --name $IDENTITY_NAME --query clientId -o tsv)
$IDENTITY_PRINCIPAL_ID=$(az identity show --resource-group $RG --name $IDENTITY_NAME --query principalId -o tsv)
```

This identity is the Entra ID object your pod will use. You do not need a classic App Registration for this workload identity flow; Azure creates and manages the service principal behind the user-assigned managed identity.

## 7. Grant Key Vault Access

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

## 8. Configure Federated Identity Credential

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

## 9. Build And Push The Image

```powershell
$ACR_LOGIN_SERVER=$(az acr show --resource-group $RG --name $ACR_NAME --query loginServer -o tsv)

az acr login --name $ACR_NAME
docker build -t keyvault-demo:1.0.0 .
docker tag keyvault-demo:1.0.0 "$ACR_LOGIN_SERVER/keyvault-demo:1.0.0"
docker push "$ACR_LOGIN_SERVER/keyvault-demo:1.0.0"
```

## 10. Update Kubernetes Manifests

Edit `k8s/service-account.yaml`:

```yaml
azure.workload.identity/client-id: "<IDENTITY_CLIENT_ID>"
```

Edit `k8s/deployment.yaml`:

```yaml
image: <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
KEY_VAULT_URL: "https://<KEY_VAULT_NAME>.vault.azure.net/"
```

## 11. Deploy

```powershell
kubectl apply -k k8s
kubectl rollout status deployment/keyvault-demo -n keyvault-demo
kubectl get svc keyvault-demo -n keyvault-demo
```

Open the external IP shown for the LoadBalancer service.

## 12. Validate Workload Identity

```powershell
kubectl logs deploy/keyvault-demo -n keyvault-demo
kubectl describe pod -l app=keyvault-demo -n keyvault-demo
```

Expected behavior:

- The pod has projected Azure identity token environment variables.
- The app can read `cosmos-endpoint` and `cosmos-key` from Key Vault.
- Creating a note writes an item to Cosmos DB.

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
