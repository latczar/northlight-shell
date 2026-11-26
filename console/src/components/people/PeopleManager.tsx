"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { RotateCw, UserPlus, Users } from "lucide-react";
import { addPersonAction, removePersonAction, resendAction, savePersonAction, type PeopleResult } from "@/app/(app)/people/actions";
import { announce } from "@/components/ui/Announcer";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { EmptyState, Notice } from "@/components/ui/Notice";
import { ring } from "@/components/ui/ring";
import type { EmployeeAccess, Person, SyncState } from "@/lib/server/people";

type Employee = { id: string; name: string };

/*
 The People page's working part. Each person's access is said in words per employee (Uses, Approves, Manages). Adding and
 changing happen in one dialog with a checkbox per right; removing asks once, in place. After every save the app hands the
 new lists to Northlight's service, and says so plainly when that did not work.
*/
export function PeopleManager({
  clientId,
  clientName,
  agents,
  people,
  sync,
  syncError,
  signInAddress,
  selfId,
}: {
  clientId: string;
  clientName: string;
  agents: Employee[];
  people: Person[];
  sync: SyncState | null;
  syncError: string | null;
  signInAddress: string;
  selfId: string;
}) {
  const router = useRouter();
  // one dialog instance per opening (round), kept through its close so focus returns to the button that opened it
  const [dialog, setDialog] = useState<{ open: boolean; person: Person | null; round: number }>({ open: false, person: null, round: 0 });
  const openDialog = (person: Person | null) => setDialog(d => ({ open: true, person, round: d.round + 1 }));
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function finish(result: PeopleResult, done: string) {
    if (!result.ok) {
      setNotice({ tone: "danger", text: result.error });
      return false;
    }
    if (result.pushError) setNotice({ tone: "warn", text: `${done} Saved here, but Northlight's service did not take the new list yet: ${result.pushError} Use Send again.` });
    else {
      setNotice({ tone: "ok", text: done });
      announce(done);
    }
    router.refresh();
    return true;
  }

  const behind = sync && sync.pushedVersion < sync.wantedVersion;

  return (
    <div className="flex flex-col gap-6">
      {behind && (
        <Notice
          tone="warn"
          banner
          title="Northlight's service has an older access list"
          action={
            <Button
              size="sm"
              icon={<RotateCw aria-hidden="true" />}
              busy={pending && busy === "resend"}
              busyLabel="Sending"
              onClick={() => {
                setBusy("resend");
                start(async () => {
                  finish(await resendAction(clientId), "Northlight's service has the current access list.");
                  setBusy(null);
                });
              }}
            >
              Send again
            </Button>
          }
        >
          Until it does, people whose access changed cannot give their employees new work; their next message tries the send again.{sync?.lastError ? ` Last answer: ${sync.lastError}` : ""}
        </Notice>
      )}
      {syncError && <Notice tone="warn">{`Whether Northlight's service has the current list could not be read: ${syncError}`}</Notice>}
      {notice && (
        <Notice tone={notice.tone} banner>
          {notice.text}
        </Notice>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-heading text-ink">People with access to {clientName}</h2>
          <p className="text-small text-ink-2">
            They sign in at <span className="font-mono break-all">{signInAddress}</span> with their email and a code Northlight emails them.
          </p>
        </div>
        <Button variant="primary" icon={<UserPlus aria-hidden="true" />} onClick={() => openDialog(null)}>
          Add a person
        </Button>
      </div>

      {people.length === 0 ? (
        <EmptyState icon={Users} title="Nobody has access yet">
          Add the people from {clientName} who should work with their AI employees.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-rule bg-card" role="region" aria-label="People and their access" tabIndex={0}>
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-rule">
                <th scope="col" className="px-4 py-3 text-label text-ink-3 md:px-6">Person</th>
                {agents.map(a => (
                  <th key={a.id} scope="col" className="px-4 py-3 text-label text-ink-3">{a.name}</th>
                ))}
                <th scope="col" className="px-4 py-3 text-right text-label text-ink-3 md:px-6">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {people.map(person => (
                <tr key={person.userId} className="align-top">
                  <th scope="row" className="px-4 py-4 font-normal md:px-6">
                    <span className="block text-title text-ink">{person.name ?? person.email}{person.userId === selfId && <span className="text-small font-normal text-ink-3"> (you)</span>}</span>
                    {person.name && <span className="block text-small break-all text-ink-2">{person.email}</span>}
                  </th>
                  {agents.map(a => {
                    const access = person.access.find(x => x.agentId === a.id);
                    const words = access ? ["Uses", access.canApprove && "approves", access.canManage && "manages"].filter(Boolean).join(", ") : "No access";
                    return (
                      <td key={a.id} className={`px-4 py-4 text-small ${access ? "text-ink" : "text-ink-3"}`}>
                        {words}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 md:px-6">
                    {removing === person.userId ? (
                      <div className="flex flex-col items-end gap-2">
                        <span className="text-small text-ink-2">Remove {person.name ?? person.email} from {clientName}?</span>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="danger"
                            busy={pending && busy === person.userId}
                            busyLabel="Removing"
                            onClick={() => {
                              setBusy(person.userId);
                              start(async () => {
                                if (finish(await removePersonAction(clientId, person.userId, person.changedAt), `${person.name ?? person.email} no longer has access to ${clientName}.`)) setRemoving(null);
                                setBusy(null);
                              });
                            }}
                          >
                            Remove
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => openDialog(person)}>
                          Change
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(person.userId)}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AccessDialog
        key={dialog.round}
        open={dialog.open}
        person={dialog.person}
        agents={agents}
        clientName={clientName}
        onClose={() => setDialog(d => ({ ...d, open: false }))}
        onSave={async (email, name, rows) => {
          const person = dialog.person;
          const result = person ? await savePersonAction(clientId, person.userId, rows, person.changedAt) : await addPersonAction(clientId, email, name, rows);
          // a refusal stays in the dialog, beside what was typed
          if (!result.ok) return result.error;
          finish(result, person ? `Saved ${person.name ?? person.email}'s access.` : `${email.trim().toLowerCase()} has access to ${clientName}. Tell them to sign in at ${signInAddress}.`);
          return null;
        }}
      />
    </div>
  );
}

/** Add a person, or change one person's rights: one checkbox per right per employee. Approve and Manage include Use. */
function AccessDialog({
  open,
  person,
  agents,
  clientName,
  onClose,
  onSave,
}: {
  open: boolean;
  person: Person | null;
  agents: Employee[];
  clientName: string;
  onClose: () => void;
  onSave: (email: string, name: string, rows: EmployeeAccess[]) => Promise<string | null>;
}) {
  const formId = useId();
  const [email, setEmail] = useState(person?.email ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [rows, setRows] = useState<EmployeeAccess[]>(person ? person.access : agents.map(a => ({ agentId: a.id, canApprove: false, canManage: false })));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const has = (id: string) => rows.find(r => r.agentId === id);
  function toggle(id: string, right: "use" | "approve" | "manage", on: boolean) {
    setRows(current => {
      const row = current.find(r => r.agentId === id);
      if (right === "use") return on ? [...current, { agentId: id, canApprove: false, canManage: false }] : current.filter(r => r.agentId !== id);
      const next = { ...(row ?? { agentId: id, canApprove: false, canManage: false }), [right === "approve" ? "canApprove" : "canManage"]: on };
      return [...current.filter(r => r.agentId !== id), next];
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={person ? `${person.name ?? person.email}'s access` : `Add a person to ${clientName}`}
      description={person ? "Untick an employee to take it away. Approve and Manage include using the employee." : "They can sign in once you save. Approve and Manage include using the employee."}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={saving} busyLabel="Saving">
            {person ? "Save access" : "Add person"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-5"
        onSubmit={async e => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          const problem = await onSave(email, name, rows);
          setSaving(false);
          if (problem) setError(problem);
          else onClose();
        }}
      >
        {!person && (
          <>
            <Input label="Email" type="email" required autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} hint="The address they will sign in with." />
            <Input label="Name (optional)" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
          </>
        )}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-label text-ink-2">AI employees</legend>
          {agents.map(a => {
            const row = has(a.id);
            return (
              <div key={a.id} className="rounded-lg border border-rule p-4">
                <label className="flex min-h-11 items-center gap-3 text-title text-ink">
                  <input type="checkbox" checked={!!row} onChange={e => toggle(a.id, "use", e.target.checked)} className={`size-5 ${ring}`} />
                  Uses {a.name}
                </label>
                <div className="mt-2 ml-8 flex flex-col gap-2">
                  <label className={`flex min-h-11 items-start gap-3 py-1 text-small ${row ? "text-ink" : "text-ink-3"}`}>
                    <input type="checkbox" disabled={!row} checked={!!row?.canApprove} onChange={e => toggle(a.id, "approve", e.target.checked)} className={`mt-0.5 size-4 ${ring}`} />
                    <span>Approves its requests <span className="block text-ink-2">Decides what {a.name} asks to do for them.</span></span>
                  </label>
                  <label className={`flex min-h-11 items-start gap-3 py-1 text-small ${row ? "text-ink" : "text-ink-3"}`}>
                    <input type="checkbox" disabled={!row} checked={!!row?.canManage} onChange={e => toggle(a.id, "manage", e.target.checked)} className={`mt-0.5 size-4 ${ring}`} />
                    <span>Manages it <span className="block text-ink-2">Changes its settings and gives it manager-only work.</span></span>
                  </label>
                </div>
              </div>
            );
          })}
        </fieldset>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  );
}
