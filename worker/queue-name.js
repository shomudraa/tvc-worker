// Keep deployments of one Render service together, but isolate other services
// and local containers even when they share the same Redis database.
export function queueNameFor(provider, env = process.env) {
  const scope = env.RENDER_SERVICE_ID || "local";
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error("Invalid queue service scope");
  return `tvc-v3-${scope}-${provider}`;
}
