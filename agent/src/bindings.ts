import type { Bindings, ToolBindings } from "./contracts";

/** The brain's own platform resources out of the Worker's env, and nothing else: no secrets, no desk. */
export const brainBindings = ({ IMAGES, MEDIA, MEMORY, DASHBOARD, USAGE, LEARNING, LEADS }: Bindings): Bindings => ({ IMAGES, MEDIA, MEMORY, DASHBOARD, USAGE, LEARNING, LEADS });

/**
 * What tools get: the brain's resources with the Dashboard narrowed to cards and approval reads (`ToolDashboard`), so a
 * tool cannot save settings, record a decision or touch a write plan, whatever it reaches for on the stub; the media
 * library narrowed to list and head, so a tool cannot write or delete a client's files; and the lead store narrowed to the
 * intake address of a site being created, so a tool can never read a lead. Lessons use a scoped runtime callback.
 */
export function toolBindings({ IMAGES, MEDIA, MEMORY, DASHBOARD, USAGE, LEADS }: Pick<Bindings, "IMAGES" | "DASHBOARD"> & Partial<Bindings>): ToolBindings {
  return {
    IMAGES, MEMORY: MEMORY!, USAGE: USAGE!,
    MEDIA: { list: options => MEDIA!.list(options), head: key => MEDIA!.head(key) },
    ...(LEADS ? { LEADS: { idFromName: name => LEADS.idFromName(name), get: id => { const stub = LEADS.get(id); return { intakeFor: (clientId, site) => stub.intakeFor(clientId, site), intakeEnabled: () => stub.intakeEnabled() }; } } } : {}),
    DASHBOARD: {
      idFromName: name => DASHBOARD.idFromName(name),
      get: id => {
        const stub = DASHBOARD.get(id);
        return {
          post: card => stub.post(card), has: cardId => stub.has(cardId), update: (cardId, agent, fields) => stub.update(cardId, agent, fields),
          approvals: status => stub.approvals(status),
        };
      },
    },
  };
}
