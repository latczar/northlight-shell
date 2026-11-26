"use client";

import { useEffect, useState } from "react";

// The app's one polite live region, mounted once in the shell; announce() says a success out loud without putting it on screen.

const hearers = new Set<(message: string) => void>();

export function announce(message: string) {
  hearers.forEach(hear => hear(message));
}

export function Announcer() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const hear = (next: string) => {
      // emptied first, so the same words said twice are read twice
      setMessage("");
      requestAnimationFrame(() => setMessage(next));
    };
    hearers.add(hear);
    return () => {
      hearers.delete(hear);
    };
  }, []);
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  );
}
