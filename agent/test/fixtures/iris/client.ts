import { compose } from "../../../clients";

export const client = compose({
  id: "northwind", name: "Northwind Cycles", agents: ["iris"], tokenEnv: "CLIENT_TOKEN_NORTHWIND",
  userSigningEnv: "USER_SIGNING_KEY_NORTHWIND", approverSigningEnv: "APPROVER_SIGNING_KEY_NORTHWIND",
  accessSigningEnv: "ACCESS_SIGNING_KEY_NORTHWIND", permissions: ["setup.read"],
  model: { baseURL: "https://model.invalid", model: "sandbox", secretEnv: "OPENAI_API_KEY",
    inputCostPerMillion: 0, outputCostPerMillion: 0, maxOutputTokens: 1000, contextWindowTokens: 100000 },
}, { "iris": {
  permissions: ["seo.read", "website.copy.review", "website.release.read", "website.preview"], schedules: [],
  settings: { site: "https://northwind.example", businessName: "Northwind Cycles", location: "York",
    copyLocale: "en-GB", repository: "cycle-co/northwind", baseBranch: "preview", reviewer: "cycle-editor",
    reviewSchedule: "northwind-weekly", releaseConnection: "northwind_release", previewConnection: "northwind_build" },
  connections: [
    { id: "managed_website", access: "read", hosts: ["northwind.example"] },
    { id: "northwind_release", access: "read", hosts: ["api.github.com"], auth: {type:"bearer",secret:"NORTHWIND_RELEASE"},
      gets: [{ method:"GET",path:"/repos/cycle-co/northwind/commits/{releaseSha}/pulls" }] },
    { id: "northwind_build", access: "write", hosts: ["api.github.com"], auth: {type:"bearer",secret:"NORTHWIND_BUILD"},
      gets: [{method:"GET",path:"/repos/cycle-co/northwind/git/ref/heads/preview"}, {method:"GET",path:"/repos/cycle-co/northwind/contents/site.json"},
        {method:"GET",path:"/repos/cycle-co/northwind/compare/*"}, {method:"GET",path:"/repos/cycle-co/northwind/pulls"},
        {method:"GET",path:"/repos/cycle-co/northwind/pulls/*/reviews"}, {method:"GET",path:"/repos/cycle-co/northwind/commits/*/pulls"}],
      writes: [{method:"POST",path:"/repos/cycle-co/northwind/git/refs",body:{ref:"refs/heads/{preview}"}},
        {method:"PUT",path:"/repos/cycle-co/northwind/contents/site.json",body:{branch:"{preview}"}},
        {method:"POST",path:"/repos/cycle-co/northwind/pulls",body:{head:"{preview}",base:"preview"}},
        {method:"POST",path:"/repos/cycle-co/northwind/pulls/*/requested_reviewers",body:{}}] },
  ],
} });
