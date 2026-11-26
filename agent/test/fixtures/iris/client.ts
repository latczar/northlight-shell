import { compose } from "../../../clients";

export const client = compose({
  id: "northwind", name: "Northwind Cycles", agents: ["iris"], tokenEnv: "CLIENT_TOKEN_NORTHWIND",
  userSigningEnv: "USER_SIGNING_KEY_NORTHWIND", approverSigningEnv: "APPROVER_SIGNING_KEY_NORTHWIND",
  accessSigningEnv: "ACCESS_SIGNING_KEY_NORTHWIND", permissions: ["setup.read"],
  model: { baseURL: "https://model.invalid", model: "sandbox", secretEnv: "OPENAI_API_KEY",
    inputCostPerMillion: 0, outputCostPerMillion: 0, maxOutputTokens: 1000, contextWindowTokens: 100000 },
}, { "iris": {
  permissions: ["seo.read", "website.copy.review"], schedules: [],
  settings: { site: "https://northwind.example", businessName: "Northwind Cycles", location: "York",
    copyLocale: "en-GB", reviewSchedule: "northwind-weekly" },
  connections: [
    { id: "managed_website", access: "read", hosts: ["northwind.example"] },
  ],
} });
