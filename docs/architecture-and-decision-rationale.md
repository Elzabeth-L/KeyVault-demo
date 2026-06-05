# Architecture And Decision Rationale

This document explains why the app uses this approach, what each Azure option means, and how the code connects to the infrastructure.

## 1. What We Are Building

The application is a secure notes workspace with registration, sign-in, and per-user notes.

User flow:

1. User opens the Next.js UI.
2. User registers or signs in.
3. Next.js calls the FastAPI authentication endpoints.
4. FastAPI reads the JWT signing secret from Key Vault and returns a signed token.
5. User creates a note with the JWT bearer token.
6. FastAPI asks Key Vault for Cosmos DB connection details.
7. FastAPI writes the note into Cosmos DB for NoSQL under the signed-in account.
8. The app runs in AKS.
9. The AKS pod authenticates to Azure through Workload Identity.

The important part is not the notes use case itself. The important part is the secure cloud pattern:

```text
AKS Pod
  -> Kubernetes ServiceAccount
  -> Azure Workload Identity
  -> User-Assigned Managed Identity
  -> Key Vault
  -> Cosmos DB credentials and JWT signing secret
  -> Cosmos DB
```

## 2. Why Monolithic Architecture

The prompt requested monolithic architecture, so the frontend and backend are packaged into one container image.

In this repo:

- Frontend: `frontend/`
- Backend: `backend/`
- Single image: `Dockerfile`
- Single Kubernetes deployment: `k8s/deployment.yaml`

Why this is good for the demo:

- Simpler deployment.
- One image to build and push.
- One Kubernetes deployment to troubleshoot.
- Easier to explain the Key Vault and Workload Identity flow.

Tradeoff:

- In production, frontend and backend are often split into separate deployments.
- Separate deployments give independent scaling and clearer release boundaries.
- For this demo, that extra complexity is not required.

## 3. Why FastAPI

FastAPI is used for the backend because:

- It is lightweight.
- It works well for REST APIs.
- It has clean request validation with Pydantic.
- It is easy to containerize.
- Azure SDK for Python is mature and supports `DefaultAzureCredential`.

Code location:

[backend/main.py](../backend/main.py)

Important code decisions:

```python
SecretClient(
    vault_url=env("KEY_VAULT_URL"),
    credential=DefaultAzureCredential(),
)
```

This means the app does not hardcode Azure credentials.

Locally, `DefaultAzureCredential` can use:

- Azure CLI login
- Visual Studio Code identity
- Environment variables, if configured

Inside AKS, it uses:

- Workload Identity token projected into the pod
- Federated user-assigned managed identity

This is why the infrastructure must configure OIDC issuer, Workload Identity, managed identity, and federated credential.

## 4. Why Next.js

Next.js is used for the frontend because:

- It matches the requested stack.
- It can run as a production Node server.
- It supports API rewrites, so the browser can call `/api/...` while Next.js forwards requests to FastAPI.

Code location:

[frontend/app/page.tsx](../frontend/app/page.tsx)

The frontend calls:

```text
/api/config
/api/auth/register
/api/auth/signin
/api/auth/me
/api/notes
/api/notes/{id}
```

These calls are proxied by:

[frontend/next.config.mjs](../frontend/next.config.mjs)

Important decision:

```js
destination: `${process.env.API_BASE_URL || "http://127.0.0.1:8000"}/api/:path*`
```

Because frontend and backend run in the same container, the Next.js server can call FastAPI through localhost.

This keeps Kubernetes simple:

- One pod
- One container
- One exposed port, `3000`
- FastAPI only listens internally on `127.0.0.1:8000`

## 5. Why Azure Key Vault

Key Vault is used to store sensitive application secrets:

- Cosmos endpoint
- Cosmos primary key
- JWT signing secret

Secret names:

```text
cosmos-endpoint
cosmos-key
auth-jwt-secret
```

These are referenced in:

[backend/main.py](../backend/main.py)

```python
endpoint = secret_client.get_secret(env("COSMOS_ENDPOINT_SECRET_NAME", "cosmos-endpoint")).value
key = secret_client.get_secret(env("COSMOS_KEY_SECRET_NAME", "cosmos-key")).value
jwt_secret = secret_client.get_secret(env("JWT_SECRET_NAME", "auth-jwt-secret")).value
```

Why this approach:

- No Cosmos key in source code.
- No Cosmos key in Docker image.
- No Cosmos key in Kubernetes Secret.
- No JWT signing secret in source code, Docker image, or Kubernetes Secret.
- Secret rotation can happen in Key Vault.
- Access is controlled through Azure RBAC.

The app reads Key Vault secrets through the workload identity managed identity and caches clients where appropriate.

Tradeoff:

- This demo still uses Cosmos account keys.
- A more production-grade approach can use Cosmos DB RBAC with managed identity instead of storing Cosmos keys.
- The prompt specifically asked to store username/password or credentials in Key Vault, so this app demonstrates that pattern.

## 6. Why Azure Cosmos DB For NoSQL

Cosmos DB for NoSQL is used because:

- It is a managed database.
- It supports JSON documents.
- It is easy to demo with a notes app.
- It integrates well with Azure.

Database:

```text
demoapp
```

Container:

```text
notes
```

Partition key:

```text
/owner
```

Code location:

[backend/main.py](../backend/main.py)

```python
database.create_container_if_not_exists(
    id=container_name,
    partition_key=PartitionKey(path="/owner"),
    offer_throughput=400,
)
```

Why `/owner` as partition key:

- Each note belongs to an owner.
- Queries commonly filter by owner.
- It gives a simple, explainable partitioning strategy.

Authentication container:

```text
users
```

Users partition key:

```text
/email
```

Why `/email` as partition key:

- Registration and sign-in look up users by email.
- Email is stable enough for this app's identity record.
- It keeps user authentication lookups simple.

## 7. Why Private Endpoints For Key Vault And Cosmos DB

The secure default is to keep platform services off the public internet path.

For this demo, use private endpoints for:

- Key Vault
- Cosmos DB

Why:

- AKS reaches these services over private IPs in the VNet.
- Public network access can be disabled.
- Private DNS keeps normal service hostnames working.
- Security teams can reason about traffic paths.
- The demo is closer to a real enterprise deployment.

Recommended portal choices:

```text
Key Vault -> Networking -> Disable public access -> Private endpoint
Cosmos DB -> Networking -> Private endpoint -> Disable public access
```

Required private DNS zones:

```text
privatelink.vaultcore.azure.net
privatelink.documents.azure.com
```

Fallback only:

If private endpoints are not available in the demo subscription, use public access restricted to named IP ranges. Do not use `All networks` as the normal path.

Cosmos DB security note:

This demo still stores the Cosmos account key in Key Vault because the prompt asked for credentials stored in Key Vault. A stronger production option is Cosmos DB RBAC with managed identity, which removes the account key dependency.

## 8. Why AKS

AKS is used because the prompt specifically requested Kubernetes deployment with OIDC and Workload Identity.

Kubernetes files:

- [k8s/namespace.yaml](../k8s/namespace.yaml)
- [k8s/service-account.yaml](../k8s/service-account.yaml)
- [k8s/deployment.yaml](../k8s/deployment.yaml)
- [k8s/service.yaml](../k8s/service.yaml)
- [k8s/kustomization.yaml](../k8s/kustomization.yaml)

AKS gives:

- Managed Kubernetes control plane.
- Azure integration.
- Workload Identity support.
- Public container image pulls from Docker Hub.
- LoadBalancer service support.

## 9. Why OIDC Issuer Is Required

OIDC issuer is required for AKS Workload Identity.

Without OIDC issuer, Azure cannot trust tokens issued by the Kubernetes cluster.

Conceptually:

```text
Kubernetes issues a service account token
Azure Entra ID validates it through the AKS OIDC issuer
Azure exchanges it for an access token for the managed identity
The pod uses that access token to call Key Vault
```

Portal option:

```text
AKS -> Advanced -> Enable OIDC issuer -> On
```

This is not optional if using Workload Identity.

## 10. Why Workload Identity Is Required

Workload Identity lets a Kubernetes pod use Microsoft Entra ID without storing credentials.

Portal option:

```text
AKS -> Advanced -> Enable workload identity -> On
```

Why it matters:

- Avoids client secrets.
- Avoids Kubernetes Secrets for Azure credentials.
- Supports least privilege.
- Works naturally with Azure SDK `DefaultAzureCredential`.

In code, this is why we can write:

```python
DefaultAzureCredential()
```

instead of manually passing tenant ID, client ID, and client secret.

## 11. Why User-Assigned Managed Identity

The pod needs an Azure identity to access Key Vault.

This demo uses a user-assigned managed identity:

```text
id-keyvault-demo
```

Why user-assigned instead of system-assigned:

- It is independent from the AKS cluster lifecycle.
- It can be referenced explicitly by client ID.
- It is clearer for federated credential setup.
- It can be reused across deployments if required.

Kubernetes service account annotation:

[k8s/service-account.yaml](../k8s/service-account.yaml)

```yaml
azure.workload.identity/client-id: "<USER_ASSIGNED_MANAGED_IDENTITY_CLIENT_ID>"
```

This tells Azure Workload Identity which managed identity the pod wants to use.

## 12. Why Federated Credential Is Required

The federated credential connects three things:

1. AKS OIDC issuer.
2. Kubernetes service account.
3. User-assigned managed identity.

Required subject:

```text
system:serviceaccount:keyvault-demo:keyvault-demo-sa
```

This subject must match:

- Kubernetes namespace: `keyvault-demo`
- Kubernetes service account: `keyvault-demo-sa`

If the namespace or service account name differs, authentication will fail.

Why this matters:

- It prevents any random pod from using the managed identity.
- Only pods running with that service account in that namespace can exchange tokens.

## 13. Why Key Vault Secrets User Role

The application only needs to read secret values.

Required role:

```text
Key Vault Secrets User
```

Scope:

```text
Key Vault
```

Why this role:

- It allows reading secret values.
- It does not grant broad Key Vault administration.
- It follows least privilege.

Where it is assigned:

- Scope: the Key Vault, such as `kv-demo-001`.
- Principal: the application user-assigned managed identity, such as `id-keyvault-demo`.
- Portal path: Key Vault > Access control (IAM) > Add role assignment > `Key Vault Secrets User` > Managed identity > User-assigned managed identity > `id-keyvault-demo`.

Do not assign this role to the AKS agent pool identity for the app secret-read path. The agent pool identity is used by nodes, while the application pod authenticates through the Workload Identity user-assigned managed identity.

Why not `Key Vault Contributor`:

- `Key Vault Contributor` manages the vault itself.
- It does not grant permission to read secret values when using Azure RBAC.

## 14. Why Docker Hub Does Not Need Azure Pull IAM

The deployment uses Docker Hub for the application image:

```text
elzabeth03/keyvault-demo:1.0.0
```

Because this is a public Docker Hub image, AKS can pull it without an Azure Container Registry and without an `AcrPull` role assignment.

If you make the Docker Hub repository private later, Kubernetes needs an image pull secret. That is Kubernetes registry authentication, not Azure IAM.

## 15. Why Custom VNet And Subnets Are Required For The Secure Flow

A custom VNet is the recommended baseline for this demo.

AKS can create networking automatically, but that makes it harder to design private endpoints, private DNS, and enterprise network controls.

In company environments, a custom VNet/subnet is often required because:

- Network ranges must be approved.
- Security teams want predictable IP ranges.
- Private endpoints need planned subnets.
- Network policies and route tables may be managed centrally.
- Private DNS zones need to be linked to the AKS VNet.

Recommended demo VNet:

```text
VNet: 10.10.0.0/16
AKS subnet: 10.10.1.0/24
Private endpoint subnet: 10.10.2.0/24
Service CIDR: 10.2.0.0/16
DNS service IP: 10.2.0.10
```

Important decision:

The Kubernetes service CIDR must not overlap with the VNet CIDR.

For this secure demo:

- Cosmos DB public access should be disabled after private endpoint setup.
- Key Vault public access should be disabled after private endpoint setup.
- Private endpoints should use `snet-private-endpoints`.
- AKS nodes should use `snet-aks-nodes`.

## 16. Why LoadBalancer Service

The Kubernetes service uses:

[k8s/service.yaml](../k8s/service.yaml)

```yaml
type: LoadBalancer
```

Why it exists in the current demo manifests:

- Easiest way to expose the demo app for a quick browser test.
- Azure automatically provisions a public load balancer.
- You can open the app using the external IP.

More secure alternatives:

- Azure Application Gateway Ingress Controller
- NGINX Ingress Controller
- Internal LoadBalancer
- ClusterIP plus kubectl port-forward
- Private ingress reachable only through VPN or ExpressRoute

Security decision:

The app endpoint can be public for a controlled demo, but the backend services should not be public. Key Vault and Cosmos DB should use private endpoints where possible.

## 17. Why Kubernetes Namespace

Namespace:

```text
keyvault-demo
```

Why:

- Keeps resources grouped.
- Makes federated identity subject explicit.
- Avoids deploying demo resources into `default`.

Namespace manifest:

[k8s/namespace.yaml](../k8s/namespace.yaml)

```yaml
metadata:
  name: keyvault-demo
  labels:
    azure.workload.identity/use: "true"
```

The workload identity label is also placed on the pod template in the deployment.

## 18. Why Environment Variables In Deployment

The deployment contains non-secret configuration:

[k8s/deployment.yaml](../k8s/deployment.yaml)

```yaml
env:
  - name: KEY_VAULT_URL
  - name: COSMOS_ENDPOINT_SECRET_NAME
  - name: COSMOS_KEY_SECRET_NAME
  - name: JWT_SECRET_NAME
  - name: COSMOS_DATABASE_NAME
  - name: COSMOS_CONTAINER_NAME
  - name: USERS_CONTAINER_NAME
```

Why this is acceptable:

- Key Vault URL is not a secret.
- Secret names are not secret values.
- Database and container names are not sensitive.

What is not stored in Kubernetes:

- Cosmos DB key
- JWT signing secret value
- Azure client secret
- Connection string

Those remain outside the cluster.

## 19. Why Docker Runs Two Processes

The monolithic container runs:

- FastAPI with Gunicorn/Uvicorn on `127.0.0.1:8000`
- Next.js on `0.0.0.0:3000`

Startup file:

[start.sh](../start.sh)

Why:

- The prompt asked for monolithic architecture.
- Next.js serves the browser app.
- FastAPI serves backend APIs.
- Next.js proxies API calls to FastAPI through localhost.

Tradeoff:

- Running two processes in one container is acceptable for a demo.
- In production, separating frontend and backend containers is usually cleaner.

## 20. Why Health Probe Uses `/healthz`

FastAPI exposes:

```text
GET /healthz
```

Kubernetes probes call:

[k8s/deployment.yaml](../k8s/deployment.yaml)

```yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 3000
```

Because Next.js proxies `/healthz` to FastAPI, Kubernetes can check the externally exposed app port.

Why readiness and liveness matter:

- Readiness decides when the pod can receive traffic.
- Liveness restarts the pod if it becomes unhealthy.

## 21. What Must Be Replaced Before Deployment

Before deploying, replace placeholders.

In [k8s/service-account.yaml](../k8s/service-account.yaml):

```yaml
azure.workload.identity/client-id: "<USER_ASSIGNED_MANAGED_IDENTITY_CLIENT_ID>"
```

In [k8s/deployment.yaml](../k8s/deployment.yaml):

```yaml
image: elzabeth03/keyvault-demo:1.0.0
value: "https://<KEY_VAULT_NAME>.vault.azure.net/"
JWT_SECRET_NAME: "auth-jwt-secret"
USERS_CONTAINER_NAME: "users"
```

## 22. End-To-End Responsibility Map

| Layer | File Or Azure Resource | Responsibility |
| --- | --- | --- |
| UI | `frontend/app/page.tsx` | Shows landing/auth screens, sends API calls, stores the session token in browser storage |
| API | `backend/main.py` | Handles register/sign-in, signs JWTs, reads Key Vault, writes Cosmos DB |
| Identity | Managed identity + federated credential | Lets pod authenticate to Azure |
| Secrets | Key Vault | Stores Cosmos endpoint, Cosmos key, and JWT signing secret |
| Data | Cosmos DB for NoSQL | Stores user and note documents |
| Runtime | Dockerfile + start.sh | Runs frontend and backend together |
| Orchestration | AKS | Runs the app container |
| Kubernetes identity | ServiceAccount | Binds pod to managed identity |
| Exposure | Kubernetes LoadBalancer Service | Gives public demo access |

## 23. Production Hardening Options

For production, improve the demo with:

- Private endpoint for Key Vault.
- Private endpoint for Cosmos DB.
- Private Docker Hub repository with a Kubernetes image pull secret if the image should not be public.
- Disable public network access.
- Use Azure CNI Overlay or company-standard CNI.
- Use ingress with TLS.
- Consider Microsoft Entra ID or another enterprise identity provider for centralized user management.
- Use Cosmos DB RBAC with managed identity instead of account keys.
- Add CI/CD pipeline.
- Add observability with Azure Monitor and Application Insights.
- Add network policies.
- Use separate frontend and backend deployments if independent scaling is needed.

## 24. Final Decision Summary

This approach was chosen because it demonstrates the requested stack while keeping the deployment explainable:

- FastAPI demonstrates Azure SDK usage clearly.
- Next.js provides a simple UI.
- Key Vault stores sensitive Cosmos credentials and the JWT signing secret.
- Cosmos DB gives a managed NoSQL backend for users and notes.
- AKS runs the containerized app.
- OIDC and Workload Identity remove the need for client secrets.
- Managed identity and RBAC provide least-privilege access.
- A monolithic container keeps the demo simple and aligned with the prompt.

## 25. Complete Authentication And Authorization Flow

This section explains how the application authenticates to Azure services.

There are multiple identities involved, and each one has a different job.

| Identity | Where It Exists | What It Does |
| --- | --- | --- |
| Your Azure user | Microsoft Entra ID | Creates resources and assigns roles |
| AKS control plane identity | Azure-managed identity | Lets AKS manage Azure infrastructure |
| AKS kubelet identity | Azure-managed identity | Lets worker nodes pull public container images |
| App user-assigned managed identity | Microsoft Entra ID | Lets the application pod read Key Vault secrets |
| Kubernetes service account | Kubernetes API | Gives the pod a Kubernetes identity |

The application does not authenticate to Azure using username/password, client secret, or certificate.

Instead, the pod uses this chain:

```text
Pod
  -> Kubernetes service account token
  -> AKS OIDC issuer
  -> Microsoft Entra token exchange
  -> User-assigned managed identity access token
  -> Key Vault
```

### Step-By-Step Workload Identity Flow

1. The pod starts in namespace `keyvault-demo`.
2. The pod uses Kubernetes service account `keyvault-demo-sa`.
3. The service account has this annotation:

```yaml
azure.workload.identity/client-id: "<USER_ASSIGNED_MANAGED_IDENTITY_CLIENT_ID>"
```

4. The pod template has this label:

```yaml
azure.workload.identity/use: "true"
```

5. Azure Workload Identity webhook detects the label.
6. The webhook mutates the pod before it starts.
7. It mounts a projected service account token into the pod.
8. It injects Azure identity environment variables used by Azure SDK.
9. FastAPI starts and calls `DefaultAzureCredential()`.
10. Azure Identity library detects the workload identity environment.
11. The library reads the projected Kubernetes token.
12. The token is sent to Microsoft Entra ID.
13. Microsoft Entra ID checks the federated credential on the managed identity.
14. If issuer, subject, and audience match, Entra ID issues an access token for the managed identity.
15. The app uses that access token to call Key Vault.
16. Key Vault checks Azure RBAC.
17. If the managed identity has `Key Vault Secrets User`, Key Vault returns the secret value.

The most important matching values are:

```text
Issuer: AKS OIDC issuer URL
Subject: system:serviceaccount:keyvault-demo:keyvault-demo-sa
Audience: api://AzureADTokenExchange
Client ID: user-assigned managed identity client ID
```

If any of these values are wrong, the pod will not be able to get an Azure token.

## 26. What AKS OIDC Issuer Really Does

OIDC means OpenID Connect.

When OIDC issuer is enabled, AKS exposes a trusted issuer URL for Kubernetes service account tokens.

That issuer URL tells Microsoft Entra ID:

```text
Tokens from this AKS cluster can be validated using this issuer metadata.
```

Without the OIDC issuer:

- Kubernetes can still run pods.
- Service accounts still exist.
- But Microsoft Entra ID cannot trust tokens from the cluster.
- Workload Identity token exchange cannot happen.

This is why OIDC issuer is a required AKS setting, not a nice-to-have.

## 27. What Federated Credential Really Does

The federated credential is created on the user-assigned managed identity.

It says:

```text
Allow a token from this AKS OIDC issuer,
for this exact Kubernetes service account subject,
with this exact audience,
to be exchanged for this managed identity.
```

For this app:

```text
Issuer: <AKS_OIDC_ISSUER_URL>
Subject: system:serviceaccount:keyvault-demo:keyvault-demo-sa
Audience: api://AzureADTokenExchange
```

This is the trust boundary.

It means another pod cannot automatically use the identity unless it runs with:

- The same namespace
- The same service account
- The same AKS issuer
- The same configured client ID

This is safer than placing an Azure client secret in Kubernetes.

## 28. What DefaultAzureCredential Does In This App

The backend uses:

```python
DefaultAzureCredential()
```

This is important because the same code can run in different places.

Locally, it may authenticate through:

- Azure CLI login
- Visual Studio Code Azure login
- Azure PowerShell login
- Environment variables, if configured

In AKS, it authenticates through:

- Workload Identity projected token
- Managed identity client ID injected into the pod
- Microsoft Entra token exchange

The code does not need to know whether it is running locally or in AKS.

That is why this line is a good cloud-native decision:

```python
credential=DefaultAzureCredential()
```

## 29. Key Vault Authorization Flow

Authentication answers:

```text
Who is calling Key Vault?
```

Authorization answers:

```text
Is that identity allowed to read this secret?
```

In this demo:

1. The pod gets an access token for `id-keyvault-demo`.
2. The app sends that token to Key Vault.
3. Key Vault validates the token with Microsoft Entra ID.
4. Key Vault checks Azure RBAC role assignments.
5. Key Vault finds `Key Vault Secrets User` assigned to `id-keyvault-demo`.
6. Key Vault allows `get secret`.
7. Key Vault returns `cosmos-endpoint` and `cosmos-key`.

Why `Key Vault Secrets User`:

- It allows reading secret values.
- It does not allow broad management of the Key Vault.
- It is the correct data-plane permission for this demo.

Common mistake:

```text
Assigning Key Vault Contributor and expecting secret read access.
```

With Azure RBAC, management-plane roles and data-plane secret access are different.

## 30. Docker Hub Image Pull Flow

The application image is stored in Docker Hub:

```text
elzabeth03/keyvault-demo:1.0.0
```

AKS pulls this image before the application code starts.

Flow:

```text
AKS scheduler places pod on node
  -> kubelet on worker node tries to pull image
  -> Docker Hub serves elzabeth03/keyvault-demo:1.0.0
  -> image is pulled to node
  -> container starts
```

For a public Docker Hub repository, no Azure pull IAM is needed.

For a private Docker Hub repository, create a Kubernetes image pull secret and reference it in the deployment.

If the image name is wrong or the repository is private without a pull secret, the pod will not start and you may see:

```text
ImagePullBackOff
ErrImagePull
```

## 31. Request Flow From Browser To Cosmos DB

This is the full runtime request path.

```text
Browser
  -> Azure Load Balancer external IP
  -> Kubernetes Service keyvault-demo
  -> AKS Pod port 3000
  -> Next.js server
  -> Next.js rewrite to FastAPI on 127.0.0.1:8000
  -> FastAPI endpoint
  -> Key Vault for Cosmos credentials
  -> Cosmos DB for NoSQL
```

For create note:

1. Browser signs in or registers through `POST /api/auth/signin` or `POST /api/auth/register`.
2. FastAPI reads `auth-jwt-secret` from Key Vault and returns a signed JWT.
3. Browser submits the note form with `Authorization: Bearer <token>`.
4. Frontend sends `POST /api/notes`.
5. Next.js receives the request on port `3000`.
6. Next.js rewrite forwards it to FastAPI on `127.0.0.1:8000`.
7. FastAPI validates the JWT and request body.
8. FastAPI gets Cosmos endpoint and key from Key Vault.
9. FastAPI creates a Cosmos client.
10. FastAPI writes the note document to the `notes` container.
11. Cosmos DB stores the document under partition key `/owner`, using the signed-in user's identity.
12. API returns the created note to the UI.

## 32. Kubernetes Object Responsibility

The Kubernetes manifests are intentionally small.

### Namespace

File:

[k8s/namespace.yaml](../k8s/namespace.yaml)

Purpose:

- Groups demo resources.
- Keeps service account subject stable.
- Avoids using the default namespace.

### Service Account

File:

[k8s/service-account.yaml](../k8s/service-account.yaml)

Purpose:

- Gives the pod a Kubernetes identity.
- Connects that Kubernetes identity to an Azure managed identity through annotation.

Important:

```yaml
azure.workload.identity/client-id: "<USER_ASSIGNED_MANAGED_IDENTITY_CLIENT_ID>"
```

### Deployment

File:

[k8s/deployment.yaml](../k8s/deployment.yaml)

Purpose:

- Runs two replicas of the app.
- Uses the service account.
- Sets non-secret config.
- Defines liveness and readiness probes.
- Labels the pod for Workload Identity.

Important:

```yaml
serviceAccountName: keyvault-demo-sa
```

```yaml
azure.workload.identity/use: "true"
```

### Service

File:

[k8s/service.yaml](../k8s/service.yaml)

Purpose:

- Exposes the app inside the cluster.
- Creates a public Azure Load Balancer for demo access.

## 33. What Azure Creates Behind The Scenes

When you create AKS, Azure creates more resources than only the AKS object.

You will usually see:

- AKS cluster resource in your resource group.
- A managed resource group created by Azure.
- Virtual machine scale set for worker nodes.
- Network security group.
- Route table, depending on networking model.
- Load balancer when you create a LoadBalancer service.
- Managed identities for AKS and kubelet.
- Disks and networking resources for nodes.

The managed resource group often has a name like:

```text
MC_<resource-group>_<aks-name>_<region>
```

Do not manually edit resources in the managed resource group unless you know exactly why. AKS expects to manage many of those resources itself.

## 34. Network Flow And Private Service Access

The current manifest exposes the app publicly because:

```yaml
type: LoadBalancer
```

Azure creates a public load balancer frontend IP.

User traffic flow:

```text
Internet
  -> Azure public Load Balancer
  -> AKS node
  -> Kubernetes Service
  -> Pod
```

This is acceptable only when the app endpoint is intentionally public for a controlled demo.

For Azure service calls:

```text
Pod
  -> Private DNS resolution
  -> Key Vault private endpoint
  -> Cosmos DB private endpoint
```

Secure service access requires:

- Custom VNet and subnet design
- Private endpoint subnet
- Private DNS zones linked to the AKS VNet
- Public network access disabled
- Least-privilege IAM

If the app itself should not be public, replace the public `LoadBalancer` with:

- `ClusterIP` and `kubectl port-forward`
- internal LoadBalancer
- private ingress
- company-approved ingress gateway

## 35. Why We Are Not Using Kubernetes Secrets For Cosmos Credentials

Kubernetes Secrets are better than plain config maps, but they are still stored inside the cluster.

For this demo, Key Vault is a better fit because:

- Secret values stay in Azure Key Vault.
- Azure RBAC controls access.
- Secret access is audited in Azure.
- Rotation can happen without rebuilding the image.
- The app proves Azure SDK and Workload Identity integration.

Kubernetes still receives only non-secret settings:

```text
KEY_VAULT_URL
COSMOS_ENDPOINT_SECRET_NAME
COSMOS_KEY_SECRET_NAME
JWT_SECRET_NAME
COSMOS_DATABASE_NAME
COSMOS_CONTAINER_NAME
USERS_CONTAINER_NAME
```

## 36. Failure Points And What They Mean

| Symptom | Likely Layer | What To Check |
| --- | --- | --- |
| `ImagePullBackOff` | Image registry | Docker Hub image exists, repository visibility, image pull secret if private |
| Pod starts but Key Vault call fails | Workload Identity or Key Vault IAM | Service account annotation, federated credential, `Key Vault Secrets User` |
| Error says issuer/subject mismatch | Federated credential | Namespace and service account names exactly match |
| Key Vault returns forbidden | Key Vault RBAC | Managed identity has secret data-plane role |
| Register or sign-in fails | Auth secret or users container | `auth-jwt-secret`, `users` container, `/email` partition key |
| Cosmos write fails | Cosmos credentials or networking | Secret values, public access, database/container |
| LoadBalancer has no IP | AKS networking | Company policy, service events, public LB restrictions |
| `/api/notes` fails from UI | App routing | Next.js rewrite and FastAPI health |

## 37. Mental Model For The Complete System

Think of the system as four separate trust decisions.

### 1. Can The User Create Azure Resources?

Controlled by Azure RBAC on subscription or resource group.

Needed roles:

- `Contributor`
- `User Access Administrator`, or admin help for role assignments

### 2. Can AKS Pull The Image?

Controlled by Kubernetes image pull configuration and Docker Hub repository access.

Needed configuration:

- Public image `elzabeth03/keyvault-demo:1.0.0`, or a Kubernetes image pull secret if the Docker Hub repository is private

### 3. Can The Pod Become The Managed Identity?

Controlled by:

- AKS OIDC issuer
- Workload Identity webhook
- Kubernetes service account
- Federated credential on managed identity

Needed match:

```text
system:serviceaccount:keyvault-demo:keyvault-demo-sa
```

### 4. Can The Managed Identity Read Secrets?

Controlled by Key Vault Azure RBAC.

Needed role:

- `Key Vault Secrets User`

Once these four decisions are correct, the app can start, authenticate, read Key Vault, and write to Cosmos DB.
