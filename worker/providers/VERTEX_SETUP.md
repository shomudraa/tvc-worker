# Vertex AI on Render

This provider uses the project-scoped Vertex AI API, not AI Studio billing.
Model availability, quota, credit eligibility and successful output must be verified in your own Google Cloud project.

1. Select the Google Cloud project linked to the billing account with your credits.
2. Enable the Vertex AI API (`aiplatform.googleapis.com`).
3. Create or use a dedicated service account with the **Vertex AI User** role (`roles/aiplatform.user`) on that project.
4. Download its JSON key yourself. Never commit it or paste it in chat.
5. In Render, add a **Secret File** named `google-service-account.json` and paste the full JSON there.
6. Set these environment variables:

```text
PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-service-account.json
VERTEX_MODEL=gemini-omni-1.1-flash-preview
```

Replace `YOUR_PROJECT_ID` with the project ID, not its display name or billing account ID.
No Gemini API key or Cloud Storage bucket is used by this provider.
Leave the existing Redis, timing and other app settings unchanged.

Save and redeploy. `/health` should show `provider: "vertex"`.
Submit one fresh job and confirm that Render logs begin with `vertex:`.
Check Cloud Billing reports afterward to confirm the usage is offset by your eligible credits before running more jobs.

The adapter permits input clips up to 10 seconds and limits combined input files to 14 MB for inline requests.
The request is submitted once: it does not automatically retry paid generation after errors.
Optional `VERTEX_PROMPT` overrides the editing prompt.

References:
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/edit-videos
- https://developers.google.com/identity/protocols/oauth2/service-account
