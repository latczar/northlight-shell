"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { readThemePref, setThemePref, subscribeThemePref } from "@/lib/theme";
import { Segmented } from "./Tabs";

/** The theme choice for the account menu: System (follows the device), Light or Dark, saved in this browser. */
export function ThemeSwitch() {
  const pref = useSyncExternalStore(subscribeThemePref, readThemePref, () => "system" as const);
  return (
    <Segmented
      legend="Theme"
      value={pref}
      onChange={setThemePref}
      options={[
        { value: "system", label: "System", icon: <Monitor aria-hidden="true" /> },
        { value: "light", label: "Light", icon: <Sun aria-hidden="true" /> },
        { value: "dark", label: "Dark", icon: <Moon aria-hidden="true" /> },
      ]}
    />
  );
}
