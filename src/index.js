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
            <a href="https://tunnel.eshwar.tech/secure/${country}">${country}</a>
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
