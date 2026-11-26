declare namespace Cloudflare {
  interface Env {
    CONVERSATIONS: DurableObjectNamespace<import("../src/conversation").Conversation>;
    MEMORY: DurableObjectNamespace<import("../src/memory").Memory>;
    IMAGES: R2Bucket;
    MEDIA: R2Bucket;
    DASHBOARD: DurableObjectNamespace<import("../src/dashboard").Dashboard>;
    SCHEDULER: DurableObjectNamespace<import("../src/scheduler").Scheduler>;
    USAGE: DurableObjectNamespace<import("../src/usage").Usage>;
    LEARNING: DurableObjectNamespace<import("../src/learning").Learning>;
    LEADS: DurableObjectNamespace<import("../src/leads").Leads>;
    CLIENT_LIMITER: RateLimit;
    STATUS_LIMITER: RateLimit;
    STATUS_PERSON_LIMITER: RateLimit;
    DESK: import("../src/desk-api").DeskApi;
  }
}
