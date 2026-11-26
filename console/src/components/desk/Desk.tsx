"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, MessageCircle, Phone } from "lucide-react";
import { Chat } from "@/components/chat/Chat";
import { Button } from "@/components/ui/Button";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
import type { Tone } from "@/components/ui/Status";
import type { Job } from "@/lib/brain-types";
import { isActive } from "@/lib/job";
import { Disc } from "./Disc";

export type DeskTab = "overview" | "requests" | "setup" | "learned";
const TABS: DeskTab[] = ["overview", "requests", "setup", "learned"];

const ChooseTab = createContext<(tab: DeskTab) => void>(() => {});

// From 1280px the chat is a third column; below, it covers the desk like a dialog.
const WIDE = "(min-width: 80rem)";
const subscribeWide = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const isWide = () => window.matchMedia(WIDE).matches;

/** A button inside a panel that moves the desk to another tab ("Review the requests" on the Overview). */
export function TabButton({ tab, children }: { tab: DeskTab; children: ReactNode }) {
  const choose = useContext(ChooseTab);
  return (
    <Button size="sm" variant="primary" onClick={() => choose(tab)}>
      {children}
    </Button>
  );
}

/*
 An employee's desk, a two-column console layout in Northlight's colours: the disc column on the left (sticky), the desk
 on the right with the heading, Chat with <name> and the tabs. The chat opens beside the desk from 1280px and over it
 below that; it stays mounted, so a draft and the conversation survive closing it. Tab and chat live in the address
 (?tab=, ?chat=1) through the history API, so a link opens the same view without reloading the page's data.
*/
export function Desk({
  clientId,
  clientName,
  agent,
  state,
  decisions,
  proposedLessons,
  setupReady,
  calls,
  initialTab,
  initialChat,
  panels,
}: {
  clientId: string;
  clientName: string;
  agent: { id: string; name: string; role: string };
  state: { tone: Tone; word: string };
  /** requests this person can decide now */
  decisions: number;
  proposedLessons: number;
  setupReady: boolean;
  /** Iris's phone line or browser calls, and the person's call history; null when this person has no calls to Iris */
  calls: { line: { number: string; label: string } | null; talk: boolean } | null;
  initialTab: DeskTab;
  initialChat: boolean;
  panels: Record<DeskTab, ReactNode>;
}) {
  const tabsId = useId();
  const [tab, setTab] = useState<DeskTab>(initialTab);
  const [chat, setChat] = useState(initialChat);
  const [job, setJob] = useState<Job | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  // while the chat covers the desk, the desk behind it takes no focus or clicks
  const covered = chat && !wide;

  // keeps the address in step without a navigation: the page's data stays as it is
  const remember = useCallback((next: { tab?: DeskTab; chat?: boolean }) => {
    const url = new URL(window.location.href);
    if (next.tab) {
      if (next.tab === "overview") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next.tab);
      url.hash = "";
    }
    if (next.chat !== undefined) {
      if (next.chat) url.searchParams.set("chat", "1");
      else url.searchParams.delete("chat");
    }
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const chooseTab = useCallback((next: DeskTab) => {
    setTab(next);
    remember({ tab: next });
  }, [remember]);
  const openChat = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setChat(true);
    remember({ chat: true });
  };
  const closeChat = useCallback(() => {
    setChat(false);
    remember({ chat: false });
    requestAnimationFrame(() => opener.current?.focus());
  }, [remember]);

  // a link to #request-<id> lands on that request
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id.startsWith("request-")) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "center" }));
  }, []);

  const working = isActive(job);
  const shown: { tone: Tone; word: string } =
    job?.status === "needs_approval" && decisions > 0 ? { tone: "attention", word: "Needs you" }
    : working ? { tone: "live", word: job?.status === "waiting" ? "Will check back" : "Working" }
    : state;

  return (
    <div className={`grid grid-cols-1 items-start gap-x-10 gap-y-6 lg:grid-cols-[15rem_minmax(0,1fr)] ${chat ? "xl:grid-cols-[13rem_minmax(0,1fr)_26rem] xl:gap-x-8" : ""}`}>
      <aside aria-label={agent.name} inert={covered} className="flex items-center gap-5 max-[24rem]:gap-2 lg:sticky lg:top-28 lg:flex-col lg:items-stretch lg:gap-4">
        <div className="w-36 shrink-0 max-[24rem]:w-24 sm:w-44 lg:w-full">
          <Disc name={agent.name} tone={shown.tone} word={shown.word} onOpen={openChat} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Link href={`/c/${clientId}`} className="inline-flex items-center gap-1.5 self-start rounded-sm text-small font-medium text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Your team
          </Link>
          <Button
            variant={chat ? "primary" : "secondary"}
            icon={<MessageCircle aria-hidden="true" />}
            onClick={chat ? closeChat : openChat}
            aria-expanded={chat}
            aria-controls="employee-chat"
            className="max-[24rem]:h-auto max-[24rem]:min-h-11 max-[24rem]:whitespace-normal lg:w-full"
          >
            {chat ? "Close the chat" : `Chat with ${agent.name}`}
          </Button>
          {calls && (
            <div className="flex flex-col items-start gap-1 text-small">
              {calls.line && (
                <a href={`tel:${calls.line.number}`} className="inline-flex min-h-11 flex-col justify-center rounded-sm font-medium text-ink underline">
                  Call Iris <span className="tabular-nums">{calls.line.label}</span>
                </a>
              )}
              {calls.talk && (
                <Link href={`/c/${clientId}/${agent.id}/talk`} prefetch={false} className="inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-ink underline">
                  <Phone className="size-4" aria-hidden="true" />
                  Talk to {agent.name}
                </Link>
              )}
              <Link href={`/c/${clientId}/${agent.id}/calls`} prefetch={false} className="inline-flex min-h-11 items-center rounded-sm font-medium text-ink underline">
                Call history
              </Link>
            </div>
          )}
        </div>
      </aside>

      <div inert={covered} className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Link href={`/c/${clientId}`} className="hidden items-center gap-1.5 self-start rounded-sm text-small font-medium text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:inline-flex">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Your team
          </Link>
          <h1 className="text-display text-balance text-ink">What {agent.name} did</h1>
          <p className="text-small text-ink-2">
            {agent.role} · {clientName}
          </p>
        </header>
        <Tabs
          id={tabsId}
          label={`${agent.name}'s desk`}
          value={tab}
          onChange={chooseTab}
          items={[
            { value: "overview", label: "Overview" },
            { value: "requests", label: "Requests", count: decisions, note: decisions ? `${decisions} ${decisions === 1 ? "needs" : "need"} your decision` : undefined },
            { value: "setup", label: setupReady ? "Setup" : "Setup needed" },
            { value: "learned", label: "Learned", count: proposedLessons, note: proposedLessons ? `${proposedLessons} waiting for approval` : undefined },
          ]}
        />
        <ChooseTab.Provider value={chooseTab}>
          {TABS.map(value => (
            <TabPanel key={value} tabs={tabsId} value={value} hidden={tab !== value} className="animate-enter">
              {panels[value]}
            </TabPanel>
          ))}
        </ChooseTab.Provider>
      </div>

      {/* Mounted from the first render and hidden while closed, so the conversation and a half-typed message are kept. */}
      <div
        id="employee-chat"
        hidden={!chat}
        className="fixed inset-x-0 top-14 bottom-0 z-20 animate-enter md:top-16 lg:left-auto lg:w-[min(28rem,100%)] xl:sticky xl:top-28 xl:z-auto xl:col-start-3 xl:row-start-1 xl:h-[calc(100dvh-9rem)] xl:w-auto"
      >
        <Chat
          clientId={clientId}
          agentId={agent.id}
          agentName={agent.name}
          open={chat}
          onClose={closeChat}
          onJob={setJob}
          onOpenRequests={() => {
            chooseTab("requests");
            if (!wide) closeChat();
          }}
        />
      </div>
    </div>
  );
}
