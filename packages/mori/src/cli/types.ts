import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CredentialStore } from "@earendil-works/pi-ai";

export interface RunCliDeps {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  streamFn?: StreamFn;
  credentialStore?: CredentialStore;
  /** Working root for the agent's tools. Defaults to `process.cwd()`. */
  root?: string;
}
