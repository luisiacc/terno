import React from "react";
import { createRoot } from "react-dom/client";
import "@terno/ui/styles/globals.css";
import CaptureRecovery from "../../../src/components/settings/capture-recovery";
import { client } from "../../../src/rpc/connection";
import { isRpcMessage, type RpcMessage } from "@terno/core/rpc";
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const channel = new MessageChannel();
const listeners = new Set<(m: RpcMessage) => void>();
channel.port1.onmessage = ({data}) => { if(isRpcMessage(data)) for(const listener of listeners)listener(data); };
client.attach({send:(m)=>channel.port1.postMessage(m),onMessage:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener);},onClose:()=>()=>{},close:()=>channel.port1.close()});
worker.onmessage = ({data}) => {
  if(data === "ready") createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-xl p-8"><h1 className="mb-1 text-lg font-medium">Synthetic mail</h1><p className="mb-5 text-sm text-muted-foreground">Up to date</p><CaptureRecovery accountId={1}/></main>);
};
worker.postMessage(channel.port2,[channel.port2]);
Object.assign(window,{captureHarness:{valid:()=>worker.postMessage("valid"),close:()=>worker.postMessage("stop")}});
