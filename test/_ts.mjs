/**
 * Lets `node --test test/*.test.mjs` import the main process's TypeScript.
 *
 * The modules under src/main are written for electron-vite's bundler: they
 * import `./sibling` without an extension and `@shared/...` by alias. Node's
 * ESM loader accepts neither, so this file registers a hook that resolves both
 * and transpiles `.ts` sources with the project's own `typescript`. Nothing is
 * cached or written to disk.
 *
 * Usage, at the top of a test: `import "./_ts.mjs";` and then
 * `const mod = await import("../src/main/whatever.ts")` — dynamic, because a
 * static import would be resolved before the hook is registered.
 *
 * STUBS: a relative module that does not exist yet (another part of the app
 * still being written) resolves to the stub named here, so the modules that
 * import it stay testable. A stub is used only while the real file is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

const STUBS = {
  "src/main/transcript.ts":
    "export function readTranscriptSummary() { return { title: null, lastAssistantText: null, lastAt: null, cwd: null }; }\n",
};

if (isMainThread) register(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@shared/")) {
    return { url: pathToFileURL(withTs(resolvePath(ROOT, "src/shared", specifier.slice("@shared/".length)))).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (!/\.[cm]?[jt]sx?$/.test(base) && !/\.json$/.test(base)) {
      const file = withTs(base);
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
      const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
      if (rel in STUBS) return { url: `stub:${rel}`, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

function withTs(base) {
  if (existsSync(base) && !existsSync(`${base}.ts`)) {
    // A directory: its index.
    return resolvePath(base, "index.ts");
  }
  return `${base}.ts`;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("stub:")) {
    return { format: "module", source: STUBS[url.slice("stub:".length)] ?? "", shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const ts = await import("typescript");
    const fileName = fileURLToPath(url);
    const out = ts.default.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        module: ts.default.ModuleKind.ESNext,
        target: ts.default.ScriptTarget.ES2022,
        isolatedModules: true,
        esModuleInterop: true,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
