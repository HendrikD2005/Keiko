// Regression guard for Issue #12 docs drift.
// Keeps the package-surface chain and the evidence-persistence wording aligned with the real repo.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readText(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function readPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readText("package.json")) as { scripts: Record<string, string> };
}

const PACKAGE_SURFACE_CHAIN = [
  "npm run clean",
  "npm run build",
  "npm run ui:ci",
  "npm run build:ui",
  "npm run check:package-surface",
].join(" && ");

describe("Issue #12 docs drift", () => {
  it("keeps the package-surface chain exact in package.json and packaging docs", () => {
    const pkg = readPackageJson();
    const readme = readText("README.md");
    const packaging = readText("docs/npm-packaging.md");

    expect(pkg.scripts.prepack).toBe(PACKAGE_SURFACE_CHAIN);
    expect(pkg.scripts.prepublishOnly).toBe(PACKAGE_SURFACE_CHAIN);
    expect(readme).toContain(
      "See [npm packaging](https://github.com/oscharko-dev/Keiko/blob/dev/docs/npm-packaging.md) for the exact prepack chain and surface check.",
    );
    expect(packaging).toContain("npm run ui:ci");
    expect(packaging).toContain("npm run prepack");
    expect(packaging).toContain(PACKAGE_SURFACE_CHAIN);
    expect(packaging).not.toContain("prepack does not perform a hidden nested install");
  });

  it("states that gen-tests and investigate do not persist evidence manifests", () => {
    const readme = readText("README.md");
    const runbook = readText("docs/pilot/runbook.md");

    expect(readme).toContain(
      "`keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist an evidence manifest",
    );
    expect(runbook).toContain(
      "`keiko gen-tests` and `keiko investigate` print a reviewable report to stdout and do not persist a manifest",
    );
  });

  it("keeps the README opening copy free of per-run manifest claims", () => {
    const readme = readText("README.md");
    const topMatter = readme.split(/\n---\n/)[0] ?? "";

    expect(topMatter).toContain("manifest-producing surfaces emit redacted evidence for audit.");
    expect(topMatter).not.toMatch(/\b(?:every|each)\s+run\b.*\bmanifest\b/i);
  });

  it("keeps shipped README repository docs links resolvable outside the tarball", () => {
    const readme = readText("README.md");

    expect(readme).toContain("https://github.com/oscharko-dev/Keiko/tree/dev/docs");
    expect(readme).not.toMatch(/\]\((?:\.\/)?docs\//);
  });

  it("keeps UI runbook config and missing-model errors aligned with the BFF contract", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");

    expect(readme).toContain(
      "`keiko ui` can also create a local runtime config during first-run setup.",
    );
    expect(readme).toContain("Gateway config file required for model-backed UI runs");
    expect(uiRunbook).toContain("keiko ui --config <path>");
    expect(uiRunbook).toContain("They are not a standalone UI configuration source.");
    expect(uiRunbook).toContain('"code": "NO_MODEL"');
    expect(uiRunbook).toContain('"message": "No model provider is configured."');
    expect(uiRunbook).not.toContain("NO_MODEL_CONFIGURED");
    expect(uiRunbook).not.toContain(
      "Provide a gateway config via --config or environment variables",
    );
  });

  it("keeps UI host documentation aligned with the loopback bind implementation", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");
    const uiCli = readText("src/cli/ui.ts");
    const uiServer = readText("src/ui/server.ts");
    const hostContract = /validate a loopback host value.*server always binds `127\.0\.0\.1`/i;

    expect(readme).toMatch(hostContract);
    expect(uiRunbook).toMatch(hostContract);
    expect(uiCli).toContain('new Set(["127.0.0.1", "localhost"])');
    expect(uiServer).toContain('export const UI_HOST = "127.0.0.1"');
  });

  it("keeps the shipped default UI port aligned", () => {
    const readme = readText("README.md");
    const uiRunbook = readText("docs/ui-runbook.md");
    const uiServer = readText("src/ui/server.ts");

    expect(uiServer).toContain("export const DEFAULT_UI_PORT = 1983");
    expect(readme).toContain("Port to bind (default: 1983)");
    expect(uiRunbook).toContain("default `1983`");
  });

  it("keeps release docs and UI copy free of customer-specific model wording", () => {
    const combined = [
      readText("README.md"),
      readText("docs/pilot/go-no-go.md"),
      readText("docs/pilot/runbook.md"),
      readText("docs/security-and-audit-boundaries.md"),
      readText("docs/ui-runbook.md"),
      readText("ui/app/components/desktop/widgets/panels/SettingsPanel.tsx"),
    ].join("\n");
    const forbiddenPhrases = [
      ["customer", "model"],
      ["candidate", "customer", "model"],
      ["customer", "domain"],
      ["customer's", "codebase"],
      ["deployment", "target"],
      ["internal", "models"],
      ["internal", "base", "URL"],
      ["private", "model", "capabilities"],
      ["customer", "hosts"],
      ["Customer", "pilot"],
      ["model", "capability", "guide"],
    ];
    const removedGuidePath = resolve(
      process.cwd(),
      "docs",
      "pilot",
      `${["model", "capability", "guide"].join("-")}.md`,
    );

    expect(existsSync(removedGuidePath)).toBe(false);
    for (const phrase of forbiddenPhrases) {
      expect(combined).not.toMatch(new RegExp(phrase.join("\\s+"), "i"));
    }
  });

  it("states that structured-diff defaults require workflow-capable chat models", () => {
    const runbook = readText("docs/pilot/runbook.md");

    expect(runbook).toContain(
      "Keiko selects only configured chat models that declare both tool-calling and structured output.",
    );
    expect(runbook).toContain("Keep local gateway configs out of version control.");
  });

  it("keeps README surface coverage from claiming full UI parity", () => {
    const readme = readText("README.md");

    expect(readme).toContain("Surface coverage is intentionally not identical.");
    expect(readme).not.toContain("These are reachable from all three surfaces");
  });
});
