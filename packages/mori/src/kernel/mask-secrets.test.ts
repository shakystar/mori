import { describe, expect, it } from "vitest";
import { maskSecrets, SECRET_MASK_PATTERNS } from "./mask-secrets.js";

describe("secret mask patterns", () => {
  /** One sample command per pattern id. Every id must appear here. */
  const samples: Record<string, string[]> = {
    "url-userinfo": [
      "pip install https://user:token@private.example/pkg",
      "git clone https://octocat:ghp_abc123@github.com/octocat/repo.git",
    ],
    "long-flag-value": [
      "curl --token=sk-abc123 https://api.example.com",
      "aws configure set --secret AKIA1234567890",
      "curl --api-key ABCDEF123456 https://api.example.com",
    ],
    "short-p-flag": ["mysql -uroot -pMyS3cret -e 'select 1'"],
    "bearer-token": ['curl -H "Authorization: Bearer sk-ant-abcdef123456" https://api.example.com'],
    "secret-env-assignment": [
      "AWS_SECRET_ACCESS_KEY=abcdef1234 aws s3 ls",
      "MORI_API_KEY=sk-xyz pnpm start",
      "GITHUB_TOKEN=ghp_abc123 gh pr create",
    ],
  };

  it("has a test case for every masking pattern", () => {
    expect(Object.keys(samples).sort()).toEqual(
      SECRET_MASK_PATTERNS.map((entry) => entry.id).sort(),
    );
  });

  for (const entry of SECRET_MASK_PATTERNS) {
    describe(entry.id, () => {
      for (const command of samples[entry.id] ?? []) {
        it(`masks \`${command}\``, () => {
          const masked = maskSecrets(command);

          expect(masked).toContain("***");
          expect(masked).not.toBe(command);
        });
      }
    });
  }
});

describe("maskSecrets", () => {
  it("replaces URL userinfo but keeps the scheme, host and path", () => {
    const masked = maskSecrets("pip install https://user:token@private.example/pkg");

    expect(masked).toBe("pip install https://***@private.example/pkg");
    expect(masked).not.toContain("user");
    expect(masked).not.toContain("token");
  });

  it("replaces a Bearer token but keeps the rest of the command, quotes included", () => {
    const command = 'curl -H "Authorization: Bearer sk-ant-abcdef123456" https://api.example.com';
    const masked = maskSecrets(command);

    expect(masked).toBe('curl -H "Authorization: Bearer ***" https://api.example.com');
    expect(masked).not.toContain("sk-ant-abcdef123456");
  });

  it("replaces a long secret flag's value but keeps the flag name", () => {
    const masked = maskSecrets("curl --token=sk-abc123 https://api.example.com");

    expect(masked).toBe("curl --token=*** https://api.example.com");
  });

  it("replaces a -p<value> inline password but keeps the rest of the invocation", () => {
    const masked = maskSecrets("mysql -uroot -pMyS3cret -e 'select 1'");

    expect(masked).toBe("mysql -uroot -p*** -e 'select 1'");
    expect(masked).not.toContain("MyS3cret");
  });

  it("replaces a secret-shaped env assignment but keeps the variable name and the rest of the command", () => {
    const masked = maskSecrets("AWS_SECRET_ACCESS_KEY=abcdef1234 aws s3 ls s3://bucket");

    expect(masked).toBe("AWS_SECRET_ACCESS_KEY=*** aws s3 ls s3://bucket");
  });

  it("masks more than one secret in the same command", () => {
    const masked = maskSecrets(
      "GITHUB_TOKEN=ghp_abc123 curl -H 'Authorization: Bearer sk-xyz' https://api.github.com",
    );

    expect(masked).not.toContain("ghp_abc123");
    expect(masked).not.toContain("sk-xyz");
    expect(masked).toContain("GITHUB_TOKEN=***");
    expect(masked).toContain("Bearer ***");
  });

  it("leaves ordinary commands with no credential shape untouched", () => {
    const ordinary = [
      "git status",
      "pnpm test",
      "ls -la /tmp",
      "echo hello world",
      "git commit -m 'wip'",
    ];

    for (const command of ordinary) {
      expect(maskSecrets(command)).toBe(command);
    }
  });

  it("masks a single-quoted long-flag value, keeping the quotes", () => {
    const masked = maskSecrets("curl --token 'sk-live-secret' https://api.example.com");

    expect(masked).toBe("curl --token '***' https://api.example.com");
    expect(masked).not.toContain("sk-live-secret");
  });

  it("masks a double-quoted long-flag value, keeping the quotes", () => {
    const masked = maskSecrets('client --password="hunter2" --verbose');

    expect(masked).toBe('client --password="***" --verbose');
    expect(masked).not.toContain("hunter2");
  });

  it("masks a quoted secret-shaped env assignment, keeping the quotes", () => {
    const masked = maskSecrets("GITHUB_TOKEN='ghp_abc123' gh pr create");

    expect(masked).toBe("GITHUB_TOKEN='***' gh pr create");
    expect(masked).not.toContain("ghp_abc123");
  });

  it("masks a quoted -p<value> inline password, keeping the quotes", () => {
    const masked = maskSecrets("mysql -uroot -p'MyS3cret' -e 'select 1'");

    expect(masked).toBe("mysql -uroot -p'***' -e 'select 1'");
    expect(masked).not.toContain("MyS3cret");
  });

  it("does not mistake find's -print/-print0/-printf/-perm/-path/-prune for a password flag", () => {
    const commands = [
      "find . -print0 | xargs -0 mv -t archive",
      "find . -type f -printf '%f\\n'",
      "find . -perm -600",
      "find . -path './secret/*'",
      "find . -name '*.tmp' -prune -o -print",
    ];

    for (const command of commands) {
      expect(maskSecrets(command)).toBe(command);
    }
  });

  it("stops a long-flag value at a shell control operator instead of swallowing the next command", () => {
    const masked = maskSecrets("echo --token=sk-secret;git commit --allow-empty -m x");

    expect(masked).toBe("echo --token=***;git commit --allow-empty -m x");
    expect(masked).not.toContain("sk-secret");
    expect(masked).toContain("git commit --allow-empty -m x");
  });

  it("stops a secret value at a pipe or ampersand", () => {
    expect(maskSecrets("curl --token=sk-abc|tee out.log")).toBe("curl --token=***|tee out.log");
    expect(maskSecrets("curl --token=sk-abc&background")).toBe("curl --token=***&background");
  });
});
