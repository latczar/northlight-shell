"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function Progress() {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const refresh = () => {
      if (!document.hidden && navigator.onLine) router.refresh();
    };
    const timer = setInterval(refresh, 5000);
    const deadline = setTimeout(() => setPaused(true), 120_000);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      clearTimeout(deadline);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [paused, router]);
  return <div className="space-y-3">
    <p role="status">{paused ? "Your draft is still being prepared. Check for an update or reopen it later." : "Iris is checking the Services page and preparing your title. You can reopen this draft later."}</p>
    {paused && <Button onClick={() => { router.refresh(); setPaused(false); }}>Check for update</Button>}
  </div>;
}
