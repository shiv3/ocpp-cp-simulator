import { afterEach, describe, expect, it } from "bun:test";
import { PutFile } from "../fileUpload";
import { canBindBunServe } from "../../../test/bunServe";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe.skipIf(!canBindBunServe())("PutFile (#926)", () => {
  it("PUTs the file as the raw body with its name in Content-Disposition", async () => {
    let seen:
      | {
          method: string;
          type: string | null;
          disp: string | null;
          body: string;
        }
      | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = {
          method: req.method,
          type: req.headers.get("content-type"),
          disp: req.headers.get("content-disposition"),
          body: await req.text(),
        };
        return new Response("ok", { status: 201 });
      },
    });
    const file = new File(['{"a":1}\n'], "CP-DiagnosticsLog-1.jsonl", {
      type: "application/x-ndjson",
    });
    const res = await PutFile(`http://127.0.0.1:${server.port}/up`, file);
    expect(res.ok).toBe(true);
    expect(seen).toEqual({
      method: "PUT",
      type: "application/x-ndjson",
      disp: 'attachment; filename="CP-DiagnosticsLog-1.jsonl"',
      body: '{"a":1}\n',
    });
  });

  it("does not follow a redirect: a 3xx is a failed attempt", async () => {
    let hits = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        hits++;
        if (new URL(req.url).pathname === "/up") {
          return new Response(null, {
            status: 302,
            headers: { location: "/elsewhere" },
          });
        }
        return new Response("ok");
      },
    });
    const res = await PutFile(
      `http://127.0.0.1:${server.port}/up`,
      new File(["x"], "f.log"),
    );
    expect(res.ok).toBe(false);
    expect(hits).toBe(1);
  });
});
