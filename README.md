# Cloudflare Zero Trust & GCP Edge Architecture — Final Report (Verified)

## Overview

This report documents the migration of an application hosted on Google Cloud Platform (GCP) from a legacy, public-facing perimeter to a Zero Trust architecture backed by Cloudflare.

The migration transitions the infrastructure through two states:

1. **Act 1 (Legacy Baseline):** An origin VM exposed directly to the public internet via an External IP, proxying through Cloudflare with Full (Strict) TLS and rate limiting.
2. **Act 2 (Zero Trust Target):** Complete origin lockdown. The VM's public IP is removed, inbound web ports (80/443) are closed, and outbound connectivity is maintained via Cloud NAT. Ingress traffic to the application is restricted exclusively to authenticated requests passing through Cloudflare Access, Cloudflare Tunnel, and Cloudflare Workers.

---

## Technical Specifications

- **Domain & Routing:** `eshwar.tech` | **Public Hostname:** `tunnel.eshwar.tech`
- **GCP Infrastructure:** `e2-micro` (`us-central1-a`, Always Free compute tier), Debian/Ubuntu OS, Node.js/Express origin server on port 80.
- **GCP Egress Network:** Private Subnet (`default`), Cloud Router (`nat-router`) & Cloud NAT (`nat-config`, `us-central1`).
- **Edge Stack:** Cloudflare Worker (`cf-demo`), Private R2 Bucket (`country-flags`).
- **Identity Infrastructure:** Cloudflare Access integrated with GitHub OAuth 2.0. Access application: "Cloudflare Zero Trust Access." Policy: "Allow-Self-GitHub-And-Cloudflare."

---

## Phase 1 — Domain Onboarding

1. Active domain onboarding verified within the Cloudflare Dashboard for `eshwar.tech`.
2. Name servers set to Cloudflare authoritative NS records.

**Verification:** `01_active_domain.png` — Cloudflare Dashboard showing `eshwar.tech` Active. ✅

---

## Phase 2 — Legacy Baseline Setup (Public Origin & Full-Strict TLS)

*This phase establishes the baseline state prior to executing origin lockdown.*

1. **Provision Public VM:** GCP instance `origin-vm` (`e2-micro`, `us-central1-a`) with an automatically allocated External IP.
2. **Deploy Application Stack:** Express app returning request headers as JSON, listening on port 80.
3. **Configure DNS & TLS:**
   - DNS A record: `www.eshwar.tech` → `<VM_EXTERNAL_IP>` (Proxy status: Proxied).
   - Let's Encrypt TLS certificate on origin, bound to port 443.
   - Cloudflare SSL/TLS mode set to **Full (Strict)**.

**Verification:** `02_tls_strict_curl.jpg` — `curl -i https://www.eshwar.tech` returns `HTTP/2 200` with valid cert chain. ✅

---

## Phase 3 — Edge Rate Limiting Enforcement

1. **Rule configured:** Cloudflare WAF Rate Limiting — 5 requests / 10 seconds per IP → Block for 10 seconds.
2. **Validation:**
   ```bash
   for i in {1..10}; do curl -s -o /dev/null -w "%{http_code}\n" https://www.eshwar.tech; done
   ```

**Verification:**
- `03a_rate_limit_burst.png` — output transitions `200` → `429` after threshold. ✅
- `03b_rate_limit_rule_config.png` — rule shows 5 req/10s, Block, 10s duration. ✅

---

## Phase 4 — Zero Trust Pivot (Cloud NAT, Tunnel & Origin Lockdown)

### Step 1: Administrative Access

Administrative SSH access to `origin-vm` is maintained through the GCP Console's built-in SSH-in-browser client, which continues to function after the VM's external IP is removed.

**Verification:** `04a_iap_ssh_verified.png` — active SSH-in-browser session (`eshwarkamalapathy@origin-vm:~$`). ✅

### Step 2: Provision Cloud NAT Egress Pipeline

Private VMs without public IPs cannot reach external endpoints (including Cloudflare's edge connectors) using Private Google Access alone. A regional Cloud NAT was provisioned:

```bash
gcloud compute routers create nat-router --network=default --region=us-central1

gcloud compute routers nats create nat-config \
    --router=nat-router --region=us-central1 \
    --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
```

**Verification:** `04b_gcp_cloud_nat.png` — `nat-config`, network `default`, region `us-central1`, status **Running**. ✅

### Step 3: Deploy Cloudflare Tunnel

1. Zero Trust Dashboard → Networks → Tunnels → `origin-tunnel`.
2. Connector installed on the VM via `cloudflared service install <TOKEN>`.
3. Public route mapped: `tunnel.eshwar.tech` → `http://localhost:80`.

**Verification:**
- `04c_tunnel_healthy.png` — `origin-tunnel`, type `cloudflared`, status **Healthy**. ✅
- `04d_tunnel_public_app_route.png` — published route `tunnel.eshwar.tech` → `http://localhost:80`. ✅

### Step 4: Execute Origin Lockdown

1. `origin-vm` external IP set to **None**.
2. Ingress HTTP (80) / HTTPS (443) firewall rules removed.
3. Tunnel daemon restarted over Cloud NAT.

**Verification:**
- `06a_origin_lockdown.png` — `curl -v --max-time 5 http://34.41.107.254` → `Connection timed out after 5006 milliseconds`. ✅
- `05_tunnel_curl_success.jpg` — `curl -i https://tunnel.eshwar.tech` → `HTTP/2 200` (origin still reachable via tunnel; response is the base-route JSON, confirming end-to-end tunnel connectivity independent of the Access-protected `/secure` path). ✅

---

## Phase 5 — Cloudflare Access & Dual-Rule GitHub SSO

1. **GitHub OAuth App** ("Cloudflare Zero Trust Access"): Homepage `https://tunnel.eshwar.tech`, Redirect URI `https://long-thunder-ffde.cloudflareaccess.com/cdn-cgi/access/callback`.
2. **Identity Provider:** GitHub added in Zero Trust Dashboard.
3. **Access Application:** "Cloudflare Zero Trust Access," domain `tunnel.eshwar.tech`, path `secure*`.
4. **Policy** ("Allow-Self-GitHub-And-Cloudflare"), two Include rules (OR'd):
   - Emails → `eshwarkamalapathy@gmail.com`
   - Emails ending in → `cloudflare.com`

**Verification:**
- `06b_github_oauth_app.png` — OAuth app registration fields populated. ✅
- `06c_access_login_gate.png` — "Sign in to GitHub to continue to Cloudflare Zero Trust Access." ✅
- `07a_access_sso_success.png` — *(supplementary)* raw request headers post-login showing Access's injected `cf-access-authenticated-user-email` and JWT assertion — this is the evidence used to identify which header the Worker should read. ✅
- `07b_access_policy_config.png` — policy shows **both** rules: `eshwarkamalapathy@gmail.com` AND `cloudflare.com`. ✅
- `07c_access_denied_test.png` — "That account does not have access." (unauthorized GitHub account denied). ✅

---

## Phase 6 — Serverless Edge Worker & Private R2 Integration

1. **R2 Bucket:** `country-flags`, no custom domain, Public Development URL disabled.
2. **Flags uploaded via CLI:**
   ```bash
   wrangler r2 object put country-flags/SG.png --file=./SG.png --content-type=image/png
   ```
3. **Worker project** (`cf-demo`), `wrangler.toml`:
   ```toml
   name = "cf-demo"
   main = "src/index.js"
   compatibility_date = "2024-01-01"

   # Intercept traffic for tunnel.eshwar.tech/secure*
   routes = [
     { pattern = "tunnel.eshwar.tech/secure*", zone_name = "eshwar.tech" }
   ]

   # Bind private R2 bucket to the worker runtime
   [[r2_buckets]]
   binding = 'FLAGS_BUCKET'
   bucket_name = 'country-flags'
   ```
   > Route binding is declared directly in `wrangler.toml` rather than attached manually via the dashboard — the route ships as part of the Worker's config-as-code.
4. **Worker logic** (`src/index.js`):
   ```javascript
   export default {
     async fetch(request, env, ctx) {
       const url = new URL(request.url);
       const pathname = url.pathname;

       // Extract identity assertions injected by Cloudflare Access
       const email = request.headers.get("cf-access-authenticated-user-email") || "Authenticated User";
       const rawCountry = request.cf?.country || "US";
       const country = rawCountry.toUpperCase();
       const timestamp = new Date().toISOString();

       // -------------------------------------------------------------
       // Requirement 8c: /secure/${COUNTRY} -> Return Flag Image from R2
       // -------------------------------------------------------------
       const countryMatch = pathname.match(/^\/secure\/([A-Za-z]{2})$/i);
       if (countryMatch) {
         const requestedCountry = countryMatch[1].toUpperCase();
         const objectKey = `${requestedCountry}.png`;

         // Fetch flag object from private R2 bucket
         const object = await env.FLAGS_BUCKET.get(objectKey);

         if (!object) {
           return new Response(`Flag asset '${objectKey}' not found in R2 bucket`, {
             status: 404,
             headers: { "content-type": "text/plain" }
           });
         }

         const headers = new Headers();
         object.writeHttpMetadata(headers);
         headers.set("content-type", "image/png");

         // Optimization: Cache flag assets at the Edge and Browser for 24 hours
         headers.set("cache-control", "public, max-age=86400, s-maxage=86400");

         return new Response(object.body, { headers });
       }

       // -------------------------------------------------------------
       // Requirement 8b: /secure -> Return HTML Identity Info Response
       // -------------------------------------------------------------
       if (pathname === "/secure" || pathname === "/secure/") {
         const htmlContent = `<!DOCTYPE html>
   <html lang="en">
   <head>
       <meta charset="UTF-8">
       <title>Zero Trust Identity Check</title>
       <style>
         body { font-family: system-ui, -apple-system, sans-serif; padding: 2rem; background: #f4f4f5; color: #18181b; }
         .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto; }
         a { color: #2563eb; font-weight: 600; text-decoration: none; }
         a:hover { text-decoration: underline; }
         code { background: #e4e4e7; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
       </style>
   </head>
   <body>
       <div class="card">
           <h2>Zero Trust Identity Payload</h2>
           <p>
               <strong>${email}</strong> authenticated at
               <code>${timestamp}</code> from
               <a href="/secure/${country}">${country}</a>
           </p>
       </div>
   </body>
   </html>`;

         return new Response(htmlContent, {
           headers: {
             "content-type": "text/html;charset=UTF-8",
           },
         });
       }

       return new Response("Not Found", { status: 404 });
     },
   };
   ```
5. **Deployed via Wrangler CLI** (`npx wrangler deploy`); route bound via `wrangler.toml`, not the dashboard.

**Verification:**
- `08a_r2_private_settings.png` — bucket `country-flags`, no custom domain, Public Development URL **disabled**. ✅
- `08b_wrangler_deploy_output.png` — `npx wrangler deploy` succeeded, binding `env.FLAGS_BUCKET (country-flags)` confirmed, route `tunnel.eshwar.tech/secure*` deployed. ✅
- `09_worker_route.png` — Custom Domains and Routes: `tunnel.eshwar.tech/secure*`, zone `eshwar.tech`. ✅
- `10_secure_identity_payload.png` — renders `eshwarkamalapathy@gmail.com authenticated at 2026-09-06T18:26:06.644Z from SG`. ✅
- `11_worker_r2_flag_display.png` — Singapore flag renders correctly from R2. ✅
- `12a_content_type_html.png` — `/secure` → `Content-Type: text/html;charset=UTF-8`, `200 OK`. ✅
- `12b_content_type_image.png` — `/secure/SG` → `Content-Type: image/png`, `200 OK`. ✅
- `13_public_github_repo.png` — **⚠️ Still outstanding.** Push the Worker code to a public GitHub repo and capture the repo listing before submission.

---

## Submission Artifact Index

| # | Artifact Filename | Status | Evidence / Architectural Proof |
|---|---|---|---|
| 01 | `01_active_domain.png` | ✅ | Active DNS zone in Cloudflare |
| 02 | `02_tls_strict_curl.jpg` | ✅ | Act 1 baseline: Full (Strict) TLS on public origin |
| 03a | `03a_rate_limit_burst.png` | ✅ | Rate limit burst: 200 → 429 |
| 03b | `03b_rate_limit_rule_config.png` | ✅ | Rate limit rule configuration |
| 04a | `04a_iap_ssh_verified.png` | ✅ | Admin access preserved via GCP Console SSH |
| 04b | `04b_gcp_cloud_nat.png` | ✅ | Cloud NAT gateway operational |
| 04c | `04c_tunnel_healthy.png` | ✅ | Cloudflare Tunnel Healthy |
| 04d | `04d_tunnel_public_app_route.png` | ✅ | Public route → `localhost:80` |
| 05 | `05_tunnel_curl_success.jpg` | ✅ | Tunnel reachable post-lockdown |
| 06a | `06a_origin_lockdown.png` | ✅ | Direct-IP connection times out (core pivot proof) |
| 06b | `06b_github_oauth_app.png` | ✅ | GitHub OAuth app registration |
| 06c | `06c_access_login_gate.png` | ✅ | GitHub SSO challenge intercepting `/secure` |
| 07a | `07a_access_sso_success.png` | ✅ | Access-injected identity headers post-login (supplementary) |
| 07b | `07b_access_policy_config.png` | ✅ | Dual-rule policy: email AND `@cloudflare.com` |
| 07c | `07c_access_denied_test.png` | ✅ | Unauthorized user denied |
| 08a | `08a_r2_private_settings.png` | ✅ | R2 bucket `country-flags` is private |
| 08b | `08b_wrangler_deploy_output.png` | ✅ | Worker deployed via Wrangler CLI |
| 09 | `09_worker_route.png` | ✅ | Route bound to `tunnel.eshwar.tech/secure*` |
| 10 | `10_secure_identity_payload.png` | ✅ | Identity payload renders correctly |
| 11 | `11_worker_r2_flag_display.png` | ✅ | Flag asset served from private R2 |
| 12a | `12a_content_type_html.png` | ✅ | `/secure` returns `text/html` |
| 12b | `12b_content_type_image.png` | ✅ | `/secure/SG` returns `image/png` |
| 13 | `13_public_github_repo.png` | ⚠️ **Pending** | Public repo of Worker code |
