import * as falai from "./falai.js";

// Production has exactly one provider. Never fall back to another paid API.
export function getProvider(name = "falai") {
  if (name !== "falai") throw new Error("This version only supports PROVIDER=falai.");
  return falai;
}
