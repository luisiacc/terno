// @vitest-environment jsdom
import {act,createElement,Fragment} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
vi.mock("~/rpc/connection",()=>({client:{}}));
vi.mock("~/state/diag",async()=>{const{create}=await import("zustand");return{useDiag:create(()=>({view:{engine:"running",reporting:{dsn:false}}})),restartEngine:vi.fn(),exportDiagnostics:vi.fn(),refreshDiag:vi.fn()};});
vi.stubGlobal("matchMedia",(media:string)=>({media,matches:false,addEventListener(){},removeEventListener(){}}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
const{ModalHostProvider}=await import("@terno/ui/components/modal-host");
const{ShortcutsDialog}=await import("~/components/shortcuts-dialog");
const{SettingsDialog}=await import("~/components/settings-dialog");
const{EngineStopped}=await import("~/components/diag/engine-stopped");
const{NativeReloadNotice}=await import("~/components/diag/native-reload-notice");
const{useNativeReload}=await import("~/lib/native-reload");
const{useApp}=await import("~/state/app");
const{copyDraft,createDraft,draftsSaved,editDraft,forgetDraft,markDraftMissing,setDraftTransport,useDrafts}=await import("~/lib/drafts");
const{newFields}=await import("~/lib/compose-fields");
const{useDraftRecovery}=await import("~/lib/draft-recovery-ui");
const{DEFAULT_SETTINGS}=await import("../../../../../packages/backend/src/settings");
it.each([["settings","missing"],["settings","unknown"],["shortcuts","missing"],["shortcuts","unknown"]]as const)("healthy %s must expose native %s recovery within the current modal",async(dialog,state)=>{
 const key=createDraft({...newFields(1),toText:'"Pérez, Ana" <ana@example.test>, bob@'});editDraft(key,{bodyText:"exact terminal work"});markDraftMissing(key);
 if(state==="unknown"){setDraftTransport(async()=>{throw{code:"TIMEOUT"};});await copyDraft(key);}
 const root=document.createElement("div");root.id="root";document.body.append(root);const mounted=createRoot(root);
 try{
  useApp.setState({dialog,settingsTab:"general",settings:{...DEFAULT_SETTINGS,gmailClientSecretSet:false,gmailClientSecretUnreadable:false,ai:{provider:"none",model:"",baseURL:null,preset:null,hasKey:false,keyUnreadable:false,keyHint:null,keyOrigin:null,keyConfirmed:true,local:true,capabilities:null,profiles:{}}}});
  await act(async()=>mounted.render(createElement(ModalHostProvider,null,createElement(Fragment,null,createElement(dialog==="settings"?SettingsDialog:ShortcutsDialog),createElement(EngineStopped),createElement(NativeReloadNotice)))));
  expect(document.querySelector(`[data-testid="${dialog}-dialog"][data-open]`)).not.toBeNull();
  const prior=document.querySelector<HTMLButtonElement>(`[data-testid="${dialog}-dialog"] button`)!; prior.focus();
  await act(async()=>useNativeReload.setState({anyway:vi.fn()}));
  const notice=document.querySelector<HTMLElement>('[data-testid="native-reload-notice"]')!;
  const hidden=notice.closest('[aria-hidden="true"], [inert]');
  console.log(JSON.stringify({dialog,state,modalStillOpen:!!document.querySelector(`[data-testid="${dialog}-dialog"][data-open]`),modalHost:useNativeReload.getState().modalHost?.dataset.testid??null,hiddenAncestor:hidden?.id??null}));
  expect(await draftsSaved()).toBe(false);
  expect(useDrafts.getState().drafts[key]).toMatchObject({bodyText:"exact terminal work",recovery:{state}});
  expect(hidden).toBeNull();
  expect(notice.closest(`[data-testid="${dialog}-dialog"]`)).not.toBeNull();
  for (const action of ["review", "anyway", "close"]) {
   const button = notice.querySelector<HTMLButtonElement>(`[data-testid="native-reload-${action}"]`)!;
   expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
   button.focus(); expect(document.activeElement).toBe(button);
  }
  const close=notice.querySelector<HTMLButtonElement>('[data-testid="native-reload-close"]')!;
  close.focus(); await act(async()=>close.click()); expect(document.activeElement).toBe(prior);
  await act(async()=>useNativeReload.setState({anyway:vi.fn()}));
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="native-reload-review"]')!.click());
  expect(useDraftRecovery.getState()).toMatchObject({open:true,key,reason:"reload"});
  expect(useApp.getState().dialog).toBe(dialog);
 }finally{await act(async()=>mounted.unmount());useApp.setState({dialog:null,settings:null});useNativeReload.setState({anyway:null});useDraftRecovery.setState({open:false,key:null,reason:"error"});forgetDraft(key);document.body.replaceChildren();}
});

it("keeps the reload warning when Review cannot read the editor", async () => {
 const { attachBody } = await import("~/lib/drafts");
 const key=createDraft(newFields(1)); editDraft(key,{bodyText:"old"}); markDraftMissing(key);
 const source=attachBody(key,()=>{throw new Error("read failed");}); source.changed();
 const root=document.createElement("div"); root.id="root"; document.body.append(root); const mounted=createRoot(root);
 try {
  await act(async()=>mounted.render(createElement(ModalHostProvider,null,createElement(NativeReloadNotice))));
  await act(async()=>useNativeReload.setState({anyway:vi.fn()}));
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="native-reload-review"]')!.click());
  expect(document.querySelector('[data-testid="native-reload-notice"]')).not.toBeNull();
  expect(useDraftRecovery.getState().open).toBe(false);
 } finally { await act(async()=>mounted.unmount()); useNativeReload.setState({anyway:null}); forgetDraft(key); source.dispose(); root.remove(); }
});
