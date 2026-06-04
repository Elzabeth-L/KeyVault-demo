# Azure Portal GUI Deployment Guide

This guide walks through deploying the demo app mostly through the Azure Portal GUI.

The app architecture is:

- Next.js frontend and FastAPI backend in one Docker image
- Azure Cosmos DB for NoSQL stores notes
- Azure Key Vault stores Cosmos DB endpoint and key
- AKS uses OIDC issuer and Microsoft Entra Workload ID
- A Kubernetes service account federates to a user-assigned managed identity
- The pod reads Key Vault secrets without storing Azure credentials in Kubernetes

Microsoft references:

- AKS Workload Identity overview: https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview
- AKS Workload Identity deployment: https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster
- Key Vault Azure RBAC guide: https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide

## Values To Prepare

Use names like these:

| Item | Example |
| --- | --- |
| Subscription | Your company/demo subscription |
| Resource group | `rg-aks-keyvault-demo` |
| Region | `East US` |
| ACR | `acrkvdemo001` |
| AKS | `aks-keyvault-demo` |
| Key Vault | `kv-demo-001` |
| Cosmos DB account | `cosmos-kv-demo-001` |
| Managed identity | `id-keyvault-demo` |
| Kubernetes namespace | `keyvault-demo` |
| Kubernetes service account | `keyvault-demo-sa` |
| Cosmos database | `demoapp` |
| Cosmos container | `notes` |
| Cosmos partition key | `/owner` |
| Virtual network, optional but recommended | `vnet-aks-keyvault-demo` |
| AKS node subnet, optional but recommended | `snet-aks-nodes` |
| Service CIDR | `10.2.0.0/16` |
| DNS service IP | `10.2.0.10` |

Use globally unique names for ACR, Key Vault, and Cosmos DB.

## Required IAM And Access Summary

You need two kinds of IAM:

1. Azure permissions for the person deploying the demo.
2. Runtime permissions for AKS and the application pod.

### Permissions For You, The Deployer

Your signed-in Azure user should have enough access to create resources and assign roles.

Recommended for a demo subscription or demo resource group:

| Scope | Role |
| --- | --- |
| Subscription or resource group | `Contributor` |
| Subscription or resource group | `User Access Administrator` |

Why:

- `Contributor` lets you create AKS, ACR, Cosmos DB, Key Vault, VNet, and managed identity.
- `User Access Administrator` lets you create role assignments, such as Key Vault access and ACR pull access.

If your company does not allow `User Access Administrator`, ask your Azure admin to perform the role assignments listed below.

### Required Runtime IAM

| Identity | Role | Scope | Why |
| --- | --- | --- | --- |
| User-assigned managed identity `id-keyvault-demo` | `Key Vault Secrets User` | Key Vault | Lets the pod read `cosmos-endpoint` and `cosmos-key` |
| AKS kubelet identity | `AcrPull` or equivalent repository reader role | Azure Container Registry | Lets AKS nodes pull the app image |

If you attach ACR during AKS creation, Azure normally creates the ACR pull role assignment automatically. If image pull fails later, verify this role assignment manually.

### Identities That Will Exist

| Identity | Created By | Purpose |
| --- | --- | --- |
| AKS cluster managed identity | Azure during AKS creation | AKS control plane operations |
| AKS kubelet identity | Azure during AKS creation | Node pool identity, used for image pulls |
| User-assigned managed identity `id-keyvault-demo` | You | Application pod identity for Key Vault access |

The application should use the user-assigned managed identity through Workload Identity. Do not store Azure client secrets in Kubernetes.

## VNet And Subnet Decision

Use a custom VNet for the secure flow in this guide.

Even for a demo, this is the better default because:

- Key Vault can be reached through Private Link instead of the public internet.
- Cosmos DB can be reached through Private Link instead of the public internet.
- ACR can be reached privately by AKS when using the Premium SKU.
- Your company can review and approve known IP ranges.
- The demo is closer to a real enterprise deployment.

Suggested IP plan for demo:

| Network Item | CIDR |
| --- | --- |
| VNet address space | `10.10.0.0/16` |
| AKS node subnet | `10.10.1.0/24` |
| Private endpoint subnet | `10.10.2.0/24` |
| Kubernetes service CIDR | `10.2.0.0/16` |
| Kubernetes DNS service IP | `10.2.0.10` |

Important:

- The Kubernetes service CIDR must not overlap with the VNet address space.
- The pod CIDR, if shown, must not overlap with the VNet address space.
- Key Vault, Cosmos DB, and ACR private endpoints should use the private endpoint subnet.
- Do not place private endpoints in the AKS node subnet.
- Public access should be disabled for Key Vault and Cosmos DB after private endpoints are configured.

Fallback option:

If your subscription or company policy does not allow private endpoints, you can temporarily use public access restricted to known IPs. Avoid `Allow public access from all networks`.

## 1. Create Resource Group

1. Open Azure Portal.
2. Search for `Resource groups`.
3. Select `Create`.
4. Choose your subscription.
5. Resource group name: `rg-aks-keyvault-demo`.
6. Region: choose one region, for example `East US`.
7. Select `Review + create`.
8. Select `Create`.

## 1A. Create Custom VNet And Subnets

1. Search for `Virtual networks`.
2. Select `Create`.
3. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Name: `vnet-aks-keyvault-demo`
   - Region: same region as AKS
4. IP Addresses tab:
   - IPv4 address space: `10.10.0.0/16`
5. Add the AKS subnet:
   - Subnet name: `snet-aks-nodes`
   - Starting address: `10.10.1.0`
   - Subnet size: `/24`
6. Add the private endpoint subnet:
   - Subnet name: `snet-private-endpoints`
   - Starting address: `10.10.2.0`
   - Subnet size: `/24`
7. Security tab:
   - Azure Bastion: `Disabled`
   - Azure Firewall: `Disabled`
   - DDoS protection: `Disabled` for demo
8. Select `Review + create`.
9. Select `Create`.

You will select:

- `snet-aks-nodes` during AKS creation.
- `snet-private-endpoints` when creating private endpoints for Key Vault, Cosmos DB, and ACR.

## 2. Create Azure Container Registry

1. Search for `Container registries`.
2. Select `Create`.
3. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Registry name: globally unique name, for example `acrkvdemo001`
   - Region: same region as the resource group
   - SKU: `Premium`
4. Networking tab:
   - Connectivity method: `Private access`
   - Select `Create a private endpoint`
   - Private endpoint name: `pe-acr-kvdemo`
   - Registry subresource: `registry`
   - Virtual network: `vnet-aks-keyvault-demo`
   - Subnet: `snet-private-endpoints`
   - Integrate with private DNS zone: `Yes`
   - Private DNS zone: create or use `privatelink.azurecr.io`
5. Encryption tab:
   - Leave default Microsoft-managed key
6. Select `Review + create`.
7. Select `Create`.

After creation:

1. Open the container registry.
2. Go to `Properties`.
3. Copy `Login server`, for example `acrkvdemo001.azurecr.io`.

You will use this value in `k8s/deployment.yaml`.

Security note:

- ACR private endpoint requires Premium SKU.
- If your company does not permit Premium for demos, use public network access with selected trusted IP ranges only.
- Keep `Admin user` disabled.

## 3. Create Cosmos DB For NoSQL

1. Search for `Azure Cosmos DB`.
2. Select `Create`.
3. Choose `Azure Cosmos DB for NoSQL`.
4. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Account name: globally unique, for example `cosmos-kv-demo-001`
   - Location: same region
   - Capacity mode: `Provisioned throughput`
   - Apply free tier discount: select if available
   - Limit total account throughput: optional for demo
5. Distribution tab:
   - Geo-redundancy: `Disable`
   - Multi-region writes: `Disable`
   - Availability zones: optional for demo
6. Networking tab:
   - Connectivity method: `Private endpoint`
   - Public network access: `Disabled`, if the portal allows this during creation
   - Select `Create a private endpoint`
   - Private endpoint name: `pe-cosmos-kvdemo`
   - Target sub-resource: `Sql`
   - Virtual network: `vnet-aks-keyvault-demo`
   - Subnet: `snet-private-endpoints`
   - Integrate with private DNS zone: `Yes`
   - Private DNS zone: create or use `privatelink.documents.azure.com`
7. Backup policy tab:
   - Choose `Periodic` for demo
8. Encryption tab:
   - Service-managed key
9. Select `Review + create`.
10. Select `Create`.

Create database and container:

1. Open the Cosmos DB account.
2. Go to `Data Explorer`.
3. Select `New Container`.
4. Database id:
   - Select `Create new`
   - Enter `demoapp`
5. Container id: `notes`.
6. Partition key: `/owner`.
7. Throughput:
   - Select manual throughput
   - Enter `400` RU/s
8. Select `OK`.

Copy Cosmos values:

1. Open the Cosmos DB account.
2. Go to `Settings` > `Keys`.
3. Copy `URI`.
4. Copy `PRIMARY KEY`.

You will store these two values in Key Vault.

If the portal does not let you disable public access until after creation:

1. Finish creating Cosmos DB with the private endpoint.
2. Open the Cosmos DB account.
3. Go to `Settings` > `Networking`.
4. Set public network access to `Disabled`.
5. Save.

Avoid selecting `All networks`. If you must use public access temporarily, restrict it to named IP ranges and remove those rules after testing.

## 4. Create Key Vault

1. Search for `Key vaults`.
2. Select `Create`.
3. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Key vault name: globally unique, for example `kv-demo-001`
   - Region: same region
   - Pricing tier: `Standard`
4. Access configuration tab:
   - Permission model: `Azure role-based access control`
5. Networking tab:
   - Public access: `Disabled`, if the portal allows this during creation
   - Select `Create a private endpoint`
   - Private endpoint name: `pe-kv-kvdemo`
   - Location: same region as the VNet
   - Virtual network: `vnet-aks-keyvault-demo`
   - Subnet: `snet-private-endpoints`
   - Integrate with private DNS zone: `Yes`
   - Private DNS zone: create or use `privatelink.vaultcore.azure.net`
6. Select `Review + create`.
7. Select `Create`.

If the portal asks for network access in a different layout:

- Choose `Disable public access`.
- Create a private endpoint in `snet-private-endpoints`.
- Enable private DNS integration.

If the portal does not let you disable public access until after creation:

1. Finish creating the Key Vault with the private endpoint.
2. Open the Key Vault.
3. Go to `Networking`.
4. Select `Disable public access`.
5. Select `Save`.

Do not use `Allow public access from all networks` as the default. If public access is temporarily required to add secrets from your laptop, restrict access to your current public IP only, add the secrets, then disable public access.

Create secrets:

If Key Vault public access is disabled, you must add secrets from a machine that has network access to the VNet, such as:

- A company jumpbox VM in `vnet-aks-keyvault-demo`.
- A self-hosted agent in the VNet.
- A VPN-connected admin workstation.
- Temporarily your current public IP, then disable public access again after secrets are created.

Preferred secure option:

1. Use a VM or admin host inside the VNet.
2. Open the Key Vault from that host.
3. Create the secrets.

Temporary setup option:

1. Open the Key Vault.
2. Go to `Networking`.
3. Temporarily allow your current public IP only.
4. Add the two secrets.
5. Return to `Networking`.
6. Set public access back to `Disabled`.
7. Save.

Then create secrets:

1. Open the Key Vault.
2. Go to `Objects` > `Secrets`.
3. Select `Generate/Import`.
4. Create the first secret:
   - Upload options: `Manual`
   - Name: `cosmos-endpoint`
   - Secret value: Cosmos DB `URI`
   - Enabled: `Yes`
5. Select `Create`.
6. Select `Generate/Import` again.
7. Create the second secret:
   - Upload options: `Manual`
   - Name: `cosmos-key`
   - Secret value: Cosmos DB `PRIMARY KEY`
   - Enabled: `Yes`
8. Select `Create`.

## 5. Create User-Assigned Managed Identity

1. Search for `Managed identities`.
2. Select `Create`.
3. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Region: same region
   - Name: `id-keyvault-demo`
4. Select `Review + create`.
5. Select `Create`.

Copy identity values:

1. Open the managed identity.
2. Go to `Overview`.
3. Copy `Client ID`.
4. Copy `Object (principal) ID`.

You need:

- `Client ID` for `k8s/service-account.yaml`
- `Object (principal) ID` for Key Vault role assignment

## 6. Grant Managed Identity Access To Key Vault

1. Open the Key Vault.
2. Go to `Access control (IAM)`.
3. Select `Add` > `Add role assignment`.
4. Role tab:
   - Search for `Key Vault Secrets User`
   - Select `Key Vault Secrets User`
5. Members tab:
   - Assign access to: `Managed identity`
   - Select members
   - Managed identity type: `User-assigned managed identity`
   - Subscription: your subscription
   - Select `id-keyvault-demo`
6. Select `Review + assign`.
7. Select `Review + assign` again.

If the portal shows multiple user-assigned managed identities, select the application workload identity:

```text
id-keyvault-demo
```

Do not select the AKS agent pool identity, such as `aks-keyvault-demo-agentpool`. The agent pool identity is for node operations and image pulls, not for the application pod reading Key Vault secrets.

Important: `Key Vault Contributor` is not enough for reading secret values. The pod identity needs the data-plane role `Key Vault Secrets User`.

## 7. Create AKS Cluster With OIDC And Workload Identity

1. Search for `Kubernetes services`.
2. Select `Create` > `Create a Kubernetes cluster`.
3. Basics tab:
   - Subscription: same subscription
   - Resource group: `rg-aks-keyvault-demo`
   - Cluster preset configuration: choose `Dev/Test` for demo if available
   - Kubernetes cluster name: `aks-keyvault-demo`
   - Region: same region
   - Availability zones: optional for demo
   - AKS pricing tier: `Free`
   - Kubernetes version: leave default stable version
4. Node pools tab:
   - Node size: choose a small VM size allowed by your subscription
   - Node count: `2`
   - Enable autoscaling: optional for demo
5. Access tab:
   - Authentication and authorization: select `Microsoft Entra ID authentication with Azure RBAC`, if available and approved
   - Kubernetes local accounts: disable for stronger security if your access model supports it
   - Authorized IP ranges: restrict to your company VPN/jumpbox/admin IP range if the portal shows this option
6. Networking tab:
   - Network configuration: prefer `Azure CNI Overlay` for new clusters if available
   - Virtual network: select `vnet-aks-keyvault-demo`
   - Node subnet: select `snet-aks-nodes`
   - Service CIDR: `10.2.0.0/16`
   - DNS service IP: `10.2.0.10`
   - Network policy: `None` for demo
   - DNS name prefix: leave generated or set a simple prefix
7. Integrations tab:
   - Container registry: select your ACR, for example `acrkvdemo001`
8. Monitoring tab:
   - Container insights: optional for demo
9. Advanced tab:
   - Enable OIDC issuer: `On`
   - Enable workload identity: `On`
10. Select `Review + create`.
11. Select `Create`.

After creation:

1. Open the AKS cluster.
2. Go to `Overview`.
3. Confirm the cluster is running.
4. Go to `Properties`.
5. Copy `OIDC issuer URL`.

You need the OIDC issuer URL for the federated credential.

### Verify ACR Pull IAM

If you selected ACR during AKS creation, Azure should grant the AKS kubelet identity pull access to ACR.

Verify it:

1. Open your Container Registry.
2. Go to `Access control (IAM)`.
3. Select `Role assignments`.
4. Search for `AcrPull`.
5. Confirm the AKS kubelet identity or AKS managed identity has pull access.

If it is missing:

1. Open Container Registry.
2. Go to `Access control (IAM)`.
3. Select `Add` > `Add role assignment`.
4. Role: `AcrPull`.
5. Members:
   - Assign access to: `Managed identity`
   - Select the AKS kubelet identity
6. Select `Review + assign`.

The kubelet identity name is usually visible from the AKS cluster under `Properties` or the managed resource group that Azure creates for AKS.

## 8. Create Federated Credential On Managed Identity

1. Open the managed identity `id-keyvault-demo`.
2. Go to `Settings` > `Federated credentials`.
3. Select `Add credential`.
4. Federated credential scenario:
   - Choose `Kubernetes accessing Azure resources`
5. Fill in:
   - Cluster issuer URL: paste the AKS `OIDC issuer URL`
   - Namespace: `keyvault-demo`
   - Service account: `keyvault-demo-sa`
   - Name: `fic-keyvault-demo`
   - Audience: `api://AzureADTokenExchange`
6. Select `Add`.

This creates trust between:

- Kubernetes subject: `system:serviceaccount:keyvault-demo:keyvault-demo-sa`
- Managed identity: `id-keyvault-demo`
- Entra token exchange audience: `api://AzureADTokenExchange`

You do not need to manually create an App Registration for this demo. A user-assigned managed identity plus federated credential is the cleaner path.

## 9. Build And Push Docker Image

This part is usually not practical through only the Azure Portal UI. Use one of these options.

### Option A: Build On Your Machine

Run from the project root:

```powershell
docker build -t keyvault-demo:1.0.0 .
docker tag keyvault-demo:1.0.0 <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
az acr login --name <ACR_NAME>
docker push <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
```

This works only if your machine can reach ACR. With ACR private access only, your machine must be on the VNet path, for example through VPN, ExpressRoute, or a jumpbox.

### Option B: Use Azure Cloud Shell

1. Open Azure Portal.
2. Select the Cloud Shell icon.
3. Choose `Bash` or `PowerShell`.
4. Upload the project files or clone your repo.
5. Run the same Docker build and push commands.

Important: Cloud Shell may not have network access to your private ACR endpoint. If ACR public access is disabled, prefer a VM or self-hosted build agent inside `vnet-aks-keyvault-demo`.

### Option C: Use ACR Tasks

If your code is in GitHub or Azure Repos:

1. Open Container Registry.
2. Go to `Tasks`.
3. Create a quick task or task from source.
4. Point it to the repo and Dockerfile.
5. Build image name: `keyvault-demo:1.0.0`.

If ACR is private-only, confirm your chosen build method can push to the registry. Private ACR is secure, but it also means builds must run from an allowed network path.

## 10. Update Kubernetes Manifests

Edit `k8s/service-account.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: keyvault-demo-sa
  namespace: keyvault-demo
  annotations:
    azure.workload.identity/client-id: "<MANAGED_IDENTITY_CLIENT_ID>"
```

Replace `<MANAGED_IDENTITY_CLIENT_ID>` with the Client ID from `id-keyvault-demo`.

Edit `k8s/deployment.yaml`:

```yaml
image: <ACR_LOGIN_SERVER>/keyvault-demo:1.0.0
```

Replace `<ACR_LOGIN_SERVER>` with your ACR login server.

Also update:

```yaml
- name: KEY_VAULT_URL
  value: "https://<KEY_VAULT_NAME>.vault.azure.net/"
```

Replace `<KEY_VAULT_NAME>` with your Key Vault name.

## 11. Deploy Manifests To AKS

The Azure Portal can show AKS resources, but applying YAML is usually done through Cloud Shell or local `kubectl`.

If you restricted AKS API server access with authorized IP ranges or private cluster settings, run kubectl from an allowed network location.

### Cloud Shell GUI-Friendly Flow

1. Open Azure Portal.
2. Select the Cloud Shell icon.
3. Upload the project folder or open the folder from your repo.
   - This works only if Cloud Shell can reach the AKS API server.
   - If not, use a jumpbox VM, VPN-connected machine, or company-approved admin host.
4. Connect kubectl to AKS:

```powershell
az aks get-credentials `
  --resource-group rg-aks-keyvault-demo `
  --name aks-keyvault-demo
```

5. Apply manifests:

```powershell
kubectl apply -k k8s
```

6. Check rollout:

```powershell
kubectl rollout status deployment/keyvault-demo -n keyvault-demo
kubectl get pods -n keyvault-demo
kubectl get svc -n keyvault-demo
```

7. If using the default `LoadBalancer` service, copy the external IP from the `keyvault-demo` service.
8. Open `http://<EXTERNAL-IP>`.

Security note:

The current manifest exposes a public LoadBalancer because it is easy to demonstrate. If your company does not allow public exposure, change `k8s/service.yaml` to `ClusterIP` and access it through:

- `kubectl port-forward`
- internal ingress
- internal load balancer
- company-approved ingress gateway

## 12. Verify In Azure Portal

### Verify AKS Workload Identity

1. Open AKS cluster.
2. Go to `Properties`.
3. Confirm `OIDC issuer URL` is present.
4. Confirm Workload Identity is enabled in the cluster settings.

### Verify Managed Identity Federation

1. Open `id-keyvault-demo`.
2. Go to `Federated credentials`.
3. Confirm `fic-keyvault-demo` exists.
4. Confirm:
   - Issuer matches AKS OIDC issuer URL
   - Subject matches `system:serviceaccount:keyvault-demo:keyvault-demo-sa`
   - Audience is `api://AzureADTokenExchange`

### Verify Key Vault Access

1. Open Key Vault.
2. Go to `Networking`.
3. Confirm public access is `Disabled`.
4. Confirm private endpoint connection is `Approved`.
5. Go to `Access control (IAM)`.
6. Select `Role assignments`.
7. Confirm `id-keyvault-demo` has `Key Vault Secrets User`.
8. Go to `Secrets`.
9. Confirm both secrets exist:
   - `cosmos-endpoint`
   - `cosmos-key`

### Verify Private DNS

1. Open `Private DNS zones`.
2. Confirm these zones exist and are linked to `vnet-aks-keyvault-demo`:
   - `privatelink.vaultcore.azure.net`
   - `privatelink.documents.azure.com`
   - `privatelink.azurecr.io`
3. Confirm each zone has records for the related service.

### Verify Cosmos DB Writes

1. Open Cosmos DB account.
2. Go to `Networking`.
3. Confirm public network access is `Disabled`.
4. Confirm private endpoint connection is `Approved`.
5. Go to `Data Explorer`.
6. Open database `demoapp`.
7. Open container `notes`.
8. Select `Items`.
9. Create a note in the app.
10. Refresh items and confirm the document appears.

## 13. Troubleshooting

### Pod Cannot Read Key Vault Secret

Check:

- Key Vault permission model is `Azure role-based access control`
- Key Vault public access is disabled only after private endpoint and private DNS are working
- Managed identity has `Key Vault Secrets User`
- Service account annotation uses the managed identity `Client ID`
- Federated credential subject exactly matches namespace and service account
- Deployment pod label includes `azure.workload.identity/use: "true"`
- Private DNS zone `privatelink.vaultcore.azure.net` is linked to the AKS VNet

### App Starts But Cosmos Fails

Check:

- `cosmos-endpoint` secret value is the Cosmos DB URI
- `cosmos-key` secret value is the primary key
- Cosmos DB private endpoint is approved
- Cosmos DB public network access is disabled only after private endpoint and private DNS are working
- Private DNS zone `privatelink.documents.azure.com` is linked to the AKS VNet
- Database is `demoapp`
- Container is `notes`
- Partition key is `/owner`

### Image Pull Fails

Check:

- AKS was attached to ACR during cluster creation
- Image name in deployment has the correct ACR login server
- Image tag exists in ACR under `Repositories`
- AKS kubelet identity has `AcrPull`
- ACR private endpoint is approved
- Private DNS zone `privatelink.azurecr.io` is linked to the AKS VNet

### LoadBalancer Has No External IP

Wait a few minutes, then check:

```powershell
kubectl get svc keyvault-demo -n keyvault-demo
```

If your company subscription blocks public load balancers, change the service type to `ClusterIP` and use port-forwarding:

```powershell
kubectl port-forward svc/keyvault-demo 8080:80 -n keyvault-demo
```

Then open `http://localhost:8080`.

## 14. Cleanup Through Portal

1. Open `Resource groups`.
2. Select `rg-aks-keyvault-demo`.
3. Select `Delete resource group`.
4. Type the resource group name.
5. Select `Delete`.

This deletes AKS, ACR, Key Vault, Cosmos DB, and the managed identity.
