"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-read the decision when the reviewer comes back to an open tab. */
export function RefreshReview() {
  const router = useRouter();
  useEffect(() => {
    function refresh() {
      if (document.hidden || !navigator.onLine) return;
      const feedback = document.querySelector<HTMLTextAreaElement>("article textarea");
      if (!feedback?.value.trim()) router.refresh();
    }
    function restore(event: PageTransitionEvent) {
      if (event.persisted) refresh();
    }
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
