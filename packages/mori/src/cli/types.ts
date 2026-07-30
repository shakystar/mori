import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { MoriKernel } from "../agent/index.js";
import type { ReplInputSource } from "./repl-input.js";

export interface RunCliDeps {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  streamFn?: StreamFn;
  credentialStore?: CredentialStore;
  /** Working root for the agent's tools. Defaults to `process.cwd()`. */
  root?: string;
  /**
   * Reads one line of input during `mori login`. Defaults to a readline prompt on the
   * process's stdin (cli/login.ts).
   */
  question?: (prompt: string) => Promise<string>;
  /**
   * Opens an OAuth authorization URL. Unset — the default — means the URL is printed and
   * the user opens it themselves; mori never spawns a browser on its own.
   */
  openBrowser?: (url: string) => void;
  /**
   * Test seam for `mori login`/`mori logout` only: the pi-ai `Models` those two commands
   * drive, in place of `createMoriModels(env, credentialStore)`. Substituting a provider
   * whose `auth.oauth.login` returns a canned credential is what lets the login flow be
   * tested end to end — credential persistence and auth resolution included — without a
   * real OAuth round trip. The prompt path builds its own `Models` (cli/runtime.ts,
   * agent.ts) and is unaffected by this.
   */
  loginModels?: MutableModels;
  /**
   * Opens the REPL's line source, or returns `undefined` when there is nobody to prompt —
   * which is what makes `mori` with no arguments print usage instead of looping when stdin
   * is a pipe or a closed descriptor.
   *
   * The default (index.ts) is a readline interface over `process.stdin`, gated on
   * `stdin.isTTY`. Tests substitute a scripted source so the REPL can be driven without a
   * real terminal (TESTING.md).
   */
  openReplInput?: () => ReplInputSource | undefined;
  /**
   * Test seam for substituting a `MoriKernel` in place of the real `createMoriKernel(...)`
   * (kernel/index.ts). Lets consolidation-trigger tests (#107) assert call counts and error
   * handling against a spy/stub kernel without touching disk. Unset — the default — is the
   * real kernel, exactly like every other production path.
   */
  kernel?: MoriKernel;
}
