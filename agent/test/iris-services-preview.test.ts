import { describe, expect, it } from "vitest";
import { servicesPreview } from "../agents/iris/services-preview";
import { fixture } from "./fixtures/iris/services-preview";

describe("approved Services title previews", () => {
  it("plans without writing, opens one draft PR, and returns it on retry", async () => {
    const f = fixture();
    expect((await servicesPreview.approval!(f.context,f.args)).preview).toMatchObject({proposed:f.args.proposed});
    expect(await servicesPreview.writePlan!(f.context,f.args)).toHaveLength(3);
    expect(f.writes).toEqual([]);
    const first = await servicesPreview.execute(f.context,f.args);
    expect(first.data).toMatchObject({ number:123, draft:true, url:"https://github.com/latczar/northlight-shell/pull/123" });
    expect(await servicesPreview.execute(f.context,f.args)).toEqual(first);
    expect(f.writes).toEqual(["git/refs","contents/site.json","pulls"]);
    expect(f.content()).toEqual({services:{title:f.args.proposed,photo:"shop.jpg"},home:{title:"Milbrook Auto Shop"}});
  });

  it("recovers the verified draft after GitHub creates it but the response is lost", async () => {
    const f = fixture(true);
    await expect(servicesPreview.execute(f.context, f.args)).rejects.toMatchObject({ definite: false });
    const writes = [...f.writes];
    expect(await servicesPreview.reconcile!(f.context, f.args)).toMatchObject({
      status: "succeeded", result: { data: { number: 123, draft: true } },
    });
    expect(f.writes).toEqual(writes);
  });

  it("leaves a missing PR uncertain without issuing any write", async () => {
    const f = fixture();
    expect(await servicesPreview.reconcile!(f.context, f.args)).toMatchObject({ status: "unknown" });
    expect(f.writes).toEqual([]);
  });

  it("refuses unsigned, non-pilot and non-manager requests before repository access", async () => {
    const f = fixture();
    for (const override of [{ userId: undefined }, { userId: "owner" }, { mayManageAgent: async () => false }]) {
      await expect(servicesPreview.execute({...f.context,...override},f.args)).rejects.toThrow("staff pilot manager");
    }
    expect(f.writes).toEqual([]);
  });
});
