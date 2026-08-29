import type { Session, StreamFn } from "@earendil-works/pi-agent-core";
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
   * real OAuth round trip. The prompt path builds its own `Models` and is unaffected by
   * this — see `models` below for its own, separate seam.
   */
  loginModels?: MutableModels;
  /**
   * Test seam for the prompt path only (`mori "…"`, `mori` with no args): the pi-ai
   * `Models` `cli/runtime.ts`'s auth gate and the real turn (`agent/index.ts`'s
   * `createMoriAgent`) both resolve providers/models/streaming through, in place of each
   * independently calling `createMoriModels(env, credentialStore)`. `prepareAgent` builds
   * this once — or reuses the instance injected here — and threads that SAME instance to
   * both, so a test that registers a fake provider on it (see
   * `agent/fake-provider-models.ts`'s `fakeProviderModels` helper) is guaranteed the gate
   * and the turn see the identical registration, which is the invariant `prepareAgent`'s
   * "same question of the same instance" comment requires. Unset — the default — means both build
   * their own instance from `createMoriModels`, exactly as before this seam existed. See
   * `loginModels` above for the sibling seam scoped to `mori login`/`mori logout`.
   */
  models?: MutableModels;
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
  /**
   * Sibling seam to `kernel` above (#460): the `Session` `prepareAgent` builds the harness on,
   * in place of a fresh `createHarnessSession()`. Only meaningful together with `kernel` — a
   * caller that constructs its own `MoriKernel` with a `ConversationSource` bound to a
   * specific `Session` (`createHarnessConversationSource(session)`, kernel/index.ts) must hand
   * `prepareAgent` that SAME session here, or the harness would type into a different instance
   * than the one the kernel's conversation source reads from and the binding would observe
   * nothing. Unset — the default — is a fresh session, exactly as before this seam existed.
   */
  session?: Session;
  /**
   * mori#489 — forwarded to `createMoriAgent`'s option of the same name
   * (`agent/index.ts`) when `prepareAgent` builds the agent: confines the `bash` tool's
   * writes to `root` at the kernel level instead of the ordinary "cwd pinned, nothing
   * else restricted" contract. Unset — every front end but the bench execution path — is
   * the existing unsandboxed behavior. `bench/preference-regression/runner.ts` sets this
   * for every episode it runs; nothing else needs to.
   */
  confineBashWrites?: boolean;
}
