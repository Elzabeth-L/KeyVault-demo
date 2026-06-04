# Azure Architecture Resource Layout

This document describes the Azure architecture for the AKS Key Vault Workload Identity demo. It focuses on resource placement, VNet and subnet boundaries, and the connection arrows to show in an architecture diagram.

## 1. Architecture Summary

The application is a small notes app packaged as one container image:

- Next.js frontend listens on port `3000`.
- FastAPI backend listens inside the same container on `127.0.0.1:8000`.
- Azure Cosmos DB for NoSQL stores note documents.
- Azure Key Vault stores the Cosmos DB endpoint and key.
- AKS runs the application pod.
- Azure Workload Identity lets the pod authenticate as a user-assigned managed identity.
- Private endpoints are used for Key Vault, Cosmos DB, and ACR where available.

High-level flow:

```text
User browser
  -> Public Azure Load Balancer
  -> AKS node in snet-aks-nodes
  -> Kubernetes Service keyvault-demo
  -> Pod keyvault-demo
  -> Next.js on port 3000
  -> FastAPI on localhost:8000
  -> Key Vault private endpoint for Cosmos credentials
  -> Cosmos DB private endpoint for data reads/writes
```

## 2. Resource Group Layout

Primary resource group:

```text
rg-aks-keyvault-demo
```

Resources in this resource group:

| Resource | Example name | Placement | Purpose |
| --- | --- | --- | --- |
| Virtual network | `vnet-aks-keyvault-demo` | Resource group, regional network resource | Holds AKS node subnet and private endpoint subnet |
| AKS cluster | `aks-keyvault-demo` | Resource group, attached to `snet-aks-nodes` | Runs the Kubernetes workload |
| Azure Container Registry | `acrkvdemo001` | Resource group, service outside VNet with private endpoint inside VNet | Stores the app image `keyvault-demo:1.0.0` |
| Cosmos DB account | `cosmos-kv-demo-001` | Resource group, service outside VNet with private endpoint inside VNet | Stores notes in database `demoapp`, container `notes` |
| Key Vault | `kv-demo-001` | Resource group, service outside VNet with private endpoint inside VNet | Stores `cosmos-endpoint` and `cosmos-key` secrets |
| User-assigned managed identity | `id-keyvault-demo` | Resource group, identity resource outside VNet | Identity used by the application pod through Workload Identity |
| Private endpoint for ACR | `pe-acr-kvdemo` | Inside `snet-private-endpoints` | Gives ACR a private IP in the VNet |
| Private endpoint for Cosmos DB | `pe-cosmos-kvdemo` | Inside `snet-private-endpoints` | Gives Cosmos DB a private IP in the VNet |
| Private endpoint for Key Vault | `pe-kv-kvdemo` | Inside `snet-private-endpoints` | Gives Key Vault a private IP in the VNet |
| Private DNS zone | `privatelink.azurecr.io` | Resource group, linked to VNet | Resolves ACR private endpoint names |
| Private DNS zone | `privatelink.documents.azure.com` | Resource group, linked to VNet | Resolves Cosmos DB private endpoint names |
| Private DNS zone | `privatelink.vaultcore.azure.net` | Resource group, linked to VNet | Resolves Key Vault private endpoint names |

AKS also creates a managed node resource group, usually named like:

```text
MC_rg-aks-keyvault-demo_aks-keyvault-demo_<region>
```

Resources in the AKS managed resource group:

| Resource | Placement | Purpose |
| --- | --- | --- |
| Virtual machine scale set or node VMs | Connected to `snet-aks-nodes` | AKS worker nodes |
| Network security group | Associated with AKS node networking | Controls node subnet traffic |
| Route table or network resources | Associated with AKS networking | Supports cluster routing |
| Public Azure Load Balancer | Outside the VNet boundary, connected to AKS nodes | Created by Kubernetes `Service` type `LoadBalancer` |
| Public IP address | Outside the VNet boundary | External app endpoint, such as `http://4.224.237.4` |
| AKS kubelet identity | Azure-managed identity | Lets nodes pull images from ACR |

Do not manually edit resources in the AKS managed resource group unless there is a clear operational reason. AKS owns those resources.

## 3. VNet And Subnet Layout

VNet:

```text
vnet-aks-keyvault-demo
Address space: 10.10.0.0/16
```

Subnets:

| Subnet | CIDR | Contains | Notes |
| --- | --- | --- | --- |
| `snet-aks-nodes` | `10.10.1.0/24` | AKS worker nodes and application pods running on those nodes | Select this subnet during AKS creation |
| `snet-private-endpoints` | `10.10.2.0/24` | Private endpoints for Key Vault, Cosmos DB, and ACR | Do not place AKS nodes here |

Kubernetes service network:

| Item | CIDR or IP | Placement |
| --- | --- | --- |
| Kubernetes service CIDR | `10.2.0.0/16` | Internal Kubernetes virtual network range, not a VNet subnet |
| Kubernetes DNS service IP | `10.2.0.10` | Internal Kubernetes service IP |

Important placement rule:

- `10.2.0.0/16` must not overlap with `10.10.0.0/16`.
- Private endpoints belong in `snet-private-endpoints`.
- AKS nodes belong in `snet-aks-nodes`.

## 4. What Is Inside The VNet

Inside `vnet-aks-keyvault-demo`:

| Area | Resource | Why it is inside |
| --- | --- | --- |
| `snet-aks-nodes` | AKS node pool VMs or VMSS instances | The app pod runs on these nodes |
| `snet-aks-nodes` | Application pod `keyvault-demo` | Scheduled onto AKS nodes |
| `snet-aks-nodes` | Kubernetes Service routing to the pod | Cluster networking forwards traffic to the pod |
| `snet-private-endpoints` | Key Vault private endpoint `pe-kv-kvdemo` | Private IP path to Key Vault |
| `snet-private-endpoints` | Cosmos DB private endpoint `pe-cosmos-kvdemo` | Private IP path to Cosmos DB |
| `snet-private-endpoints` | ACR private endpoint `pe-acr-kvdemo` | Private IP path for image pulls and pushes from allowed network paths |

## 5. What Is Outside The VNet

These resources are Azure platform resources that are not placed inside a subnet, even though private endpoints give them private IPs in the VNet:

| Resource | Example name | Why outside VNet |
| --- | --- | --- |
| Azure Key Vault | `kv-demo-001` | Managed platform service; private endpoint NIC is inside the VNet |
| Azure Cosmos DB | `cosmos-kv-demo-001` | Managed platform service; private endpoint NIC is inside the VNet |
| Azure Container Registry | `acrkvdemo001` | Managed platform service; private endpoint NIC is inside the VNet |
| User-assigned managed identity | `id-keyvault-demo` | Microsoft Entra identity resource, not a network resource |
| Microsoft Entra ID | Tenant `Default Directory` | Identity provider outside the VNet |
| AKS OIDC issuer | AKS-managed issuer URL | Identity trust endpoint used by Entra ID |
| Public Azure Load Balancer | Created by Kubernetes `LoadBalancer` service | Internet-facing entry point for the demo app |
| Public IP address | External app IP | Receives browser traffic from the internet |

## 6. Kubernetes Resources Inside AKS

Namespace:

```text
keyvault-demo
```

Kubernetes resources:

| Kubernetes resource | File | Purpose |
| --- | --- | --- |
| Namespace | `k8s/namespace.yaml` | Isolates the demo app resources |
| ServiceAccount | `k8s/service-account.yaml` | Connects the pod to the user-assigned managed identity |
| Deployment | `k8s/deployment.yaml` | Runs two replicas of the app container |
| Service | `k8s/service.yaml` | Exposes the app on port `80` through an Azure Load Balancer |
| Kustomization | `k8s/kustomization.yaml` | Applies all Kubernetes manifests together |

Important labels and annotations:

```yaml
azure.workload.identity/use: "true"
azure.workload.identity/client-id: "<id-keyvault-demo client id>"
```

The ServiceAccount annotation uses the managed identity client ID. The Key Vault RBAC role assignment uses the managed identity object or principal ID.

## 7. Connection Arrows For The Architecture Diagram

Use these arrows for the user request path:

```text
Internet user browser
  -> Public IP address
  -> Azure public Load Balancer
  -> AKS node in snet-aks-nodes
  -> Kubernetes Service keyvault-demo, port 80
  -> Pod keyvault-demo, container port 3000
  -> Next.js frontend
  -> FastAPI backend on 127.0.0.1:8000
```

Use these arrows for Key Vault secret access:

```text
FastAPI backend
  -> DefaultAzureCredential
  -> projected Kubernetes service account token
  -> AKS OIDC issuer
  -> Microsoft Entra ID
  -> user-assigned managed identity id-keyvault-demo
  -> Key Vault RBAC check
  -> Key Vault private endpoint in snet-private-endpoints
  -> Key Vault secrets cosmos-endpoint and cosmos-key
```

Use these arrows for Cosmos DB data access:

```text
FastAPI backend
  -> reads Cosmos endpoint and key from Key Vault
  -> private DNS resolves Cosmos hostname to private endpoint IP
  -> Cosmos DB private endpoint in snet-private-endpoints
  -> Cosmos DB account cosmos-kv-demo-001
  -> database demoapp
  -> container notes
```

Use these arrows for container image pull:

```text
AKS scheduler places pod on node
  -> kubelet on AKS node
  -> AKS kubelet identity
  -> ACR RBAC check for AcrPull
  -> private DNS resolves ACR hostname to private endpoint IP
  -> ACR private endpoint in snet-private-endpoints
  -> Azure Container Registry acrkvdemo001
  -> image keyvault-demo:1.0.0
```

Use these arrows for image build and push:

```text
Developer machine, jumpbox, or build agent
  -> Docker build
  -> ACR login
  -> ACR private endpoint if the source is on the VNet path
  -> Azure Container Registry acrkvdemo001
```

If ACR public access is temporarily used for a demo, show the push arrow through selected public IP access instead of the private endpoint.

## 8. IAM And Identity Placement

Identity resources are not inside subnets, but they are essential to the architecture.

| Identity | Location | Role assignment | Scope | Used for |
| --- | --- | --- | --- | --- |
| Signed-in Azure user | Microsoft Entra ID | `Contributor` and `User Access Administrator`, or equivalent | Subscription or `rg-aks-keyvault-demo` | Creates resources and assigns roles |
| User-assigned managed identity | `id-keyvault-demo` in the app resource group | `Key Vault Secrets User` | Key Vault `kv-demo-001` | Pod reads Key Vault secrets |
| AKS kubelet identity | AKS managed identity, usually in managed resource group | `AcrPull` | ACR `acrkvdemo001` | Nodes pull app image |
| AKS control plane identity | AKS managed identity | Azure-managed permissions | AKS infrastructure resources | Cluster operations |

The `Key Vault Secrets User` role must be assigned to `id-keyvault-demo`, not to the AKS agent pool identity.

## 9. Private DNS Placement

Private DNS zones are not subnets, but they must be linked to `vnet-aks-keyvault-demo`.

| Private DNS zone | Linked VNet | Resolves |
| --- | --- | --- |
| `privatelink.vaultcore.azure.net` | `vnet-aks-keyvault-demo` | Key Vault private endpoint |
| `privatelink.documents.azure.com` | `vnet-aks-keyvault-demo` | Cosmos DB private endpoint |
| `privatelink.azurecr.io` | `vnet-aks-keyvault-demo` | ACR private endpoint |

Diagram note:

```text
AKS node subnet
  -> Private DNS zone linked to VNet
  -> private endpoint IP in snet-private-endpoints
```

## 10. Public And Private Exposure

Public by design for this demo:

| Resource | Public exposure | Why |
| --- | --- | --- |
| Kubernetes Service `keyvault-demo` | Public LoadBalancer IP | Lets a browser open the demo app |

Private or restricted:

| Resource | Recommended exposure | Why |
| --- | --- | --- |
| Key Vault | Private endpoint, public access disabled | Secrets should not be reachable from all networks |
| Cosmos DB | Private endpoint, public access disabled | Database should not be reachable from all networks |
| ACR | Private endpoint with Premium SKU, or selected public IPs for demo | Image registry should be restricted |
| AKS API server | Authorized IP ranges or private access where policy requires | Limits cluster administration access |

If the application must not be public, replace the public LoadBalancer with one of these:

- Internal LoadBalancer.
- Ingress behind an approved private or enterprise ingress path.
- `ClusterIP` plus port-forwarding for local testing.

## 11. Diagram Boundary Recommendation

Draw the architecture with these boundaries:

1. Outer boundary: Azure subscription.
2. Inside it: resource group `rg-aks-keyvault-demo`.
3. Inside the resource group: VNet `vnet-aks-keyvault-demo`.
4. Inside the VNet: two subnets, `snet-aks-nodes` and `snet-private-endpoints`.
5. Outside the VNet but inside the resource group: Key Vault, Cosmos DB, ACR, managed identity, private DNS zones.
6. Separate side box: AKS managed resource group with nodes, public Load Balancer, public IP, and kubelet identity.
7. Outside Azure networking: Internet user browser and Microsoft Entra ID.

Recommended diagram text:

```text
Azure Subscription
└─ Resource Group: rg-aks-keyvault-demo
   ├─ VNet: vnet-aks-keyvault-demo (10.10.0.0/16)
   │  ├─ Subnet: snet-aks-nodes (10.10.1.0/24)
   │  │  └─ AKS nodes -> app pods
   │  └─ Subnet: snet-private-endpoints (10.10.2.0/24)
   │     ├─ pe-kv-kvdemo
   │     ├─ pe-cosmos-kvdemo
   │     └─ pe-acr-kvdemo
   ├─ AKS: aks-keyvault-demo
   ├─ Key Vault: kv-demo-001
   ├─ Cosmos DB: cosmos-kv-demo-001
   ├─ ACR: acrkvdemo001
   ├─ Managed Identity: id-keyvault-demo
   └─ Private DNS zones linked to VNet

AKS managed resource group
└─ Public Load Balancer + public IP + node infrastructure
```

## 12. Mermaid Diagram

```mermaid
flowchart LR
    user[Internet user browser]
    publicIp[Public IP]
    lb[Azure public Load Balancer]
    entra[Microsoft Entra ID]

    subgraph rg[Resource Group: rg-aks-keyvault-demo]
        aks[AKS: aks-keyvault-demo]
        kv[Key Vault: kv-demo-001]
        cosmos[Cosmos DB: cosmos-kv-demo-001]
        acr[ACR: acrkvdemo001]
        uami[User-assigned managed identity: id-keyvault-demo]
        dns[Private DNS zones]

        subgraph vnet[VNet: vnet-aks-keyvault-demo 10.10.0.0/16]
            subgraph aksSubnet[Subnet: snet-aks-nodes 10.10.1.0/24]
                node[AKS nodes]
                svc[Kubernetes Service keyvault-demo]
                pod[Pod: Next.js + FastAPI]
            end

            subgraph peSubnet[Subnet: snet-private-endpoints 10.10.2.0/24]
                peKv[Private endpoint: Key Vault]
                peCosmos[Private endpoint: Cosmos DB]
                peAcr[Private endpoint: ACR]
            end
        end
    end

    user --> publicIp --> lb --> node --> svc --> pod
    pod --> dns
    pod --> entra --> uami
    uami --> kv
    pod --> peKv --> kv
    pod --> peCosmos --> cosmos
    node --> peAcr --> acr
```

## 13. Checklist For Final Architecture Review

- `aks-keyvault-demo` uses `snet-aks-nodes`.
- Key Vault private endpoint uses `snet-private-endpoints`.
- Cosmos DB private endpoint uses `snet-private-endpoints`.
- ACR private endpoint uses `snet-private-endpoints`.
- Private DNS zones are linked to `vnet-aks-keyvault-demo`.
- `id-keyvault-demo` has `Key Vault Secrets User` on `kv-demo-001`.
- AKS kubelet identity has `AcrPull` on `acrkvdemo001`.
- Kubernetes ServiceAccount has the `id-keyvault-demo` client ID annotation.
- Deployment pod template has `azure.workload.identity/use: "true"`.
- Public LoadBalancer exists only for demo app access.
- Key Vault and Cosmos DB public access are disabled after private endpoint setup.
