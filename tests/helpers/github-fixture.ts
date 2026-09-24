import { createHash } from "node:crypto";
export const commitA = "a".repeat(40), commitB = "b".repeat(40), folderSha = "c".repeat(40);
export const markdown = "# Learning notes\n\nA **useful idea** for agents.\n\n<script>window.githubInjected=true</script>\n\n![remote](https://example.invalid/tracker.png)\n\n[unsafe](javascript:alert(1))\n\n## Next steps\n\nCompare two strategies.\n";
export const code = "// Learning example\nexport function add(a: number, b: number) {\n  return a + b;\n}\n";
export function githubFixture(pdf: Uint8Array) {
  const files = new Map<string, Buffer>([["README.md", Buffer.from(markdown)], ["src/example.ts", Buffer.from(code)], ["paper.pdf", Buffer.from(pdf)]]);
  const sha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  const entry = (name: string, filePath = name) => ({ path: name, sha: sha(files.get(filePath)!), size: files.get(filePath)!.length, type: "blob", mode: "100644" });
  const repo = { full_name: "learner/course", description: "Learning materials", private: false, default_branch: "main" };
  const requests: { url: string; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push({ url: url.href, authorization: new Headers(init?.headers).get("authorization") });
    if (url.origin !== "https://api.github.com") throw new Error("Wrong origin");
    if (url.pathname === "/user") return Response.json({ login: "learner" });
    if (url.pathname === "/user/starred" || url.pathname === "/user/repos") return Response.json([repo]);
    if (url.pathname === "/search/repositories") return Response.json({ items: [repo] });
    if (url.pathname === "/repos/learner/course") return Response.json(repo);
    if (url.pathname.includes("/commits/")) return Response.json({ sha: url.pathname.endsWith(commitB) ? commitB : commitA });
    if (url.pathname.endsWith(`/trees/${folderSha}`)) return Response.json({ tree: [entry("example.ts", "src/example.ts")] });
    if (url.pathname.includes("/trees/")) return Response.json({ tree: [entry("README.md"), entry("paper.pdf"), { path: "src", mode: "040000", type: "tree", sha: folderSha }, { path: "linked", mode: "120000", type: "blob", sha: "d".repeat(40) }] });
    if (url.pathname.includes("/blobs/")) {
      const bytes = [...files.values()].find(b => url.pathname.endsWith(sha(b)));
      if (bytes) return new Response(bytes);
    }
    return new Response("Missing fixture", { status: 404 });
  }) as typeof fetch;
  return { files, requests, fetcher };
}
