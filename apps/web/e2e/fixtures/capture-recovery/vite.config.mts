import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({root:resolve(import.meta.dirname,"../../.."),plugins:[react(),tailwindcss()],resolve:{alias:{"~":resolve(import.meta.dirname,"../../../src")}},server:{host:"127.0.0.1",port:61810,strictPort:true,fs:{allow:[resolve(import.meta.dirname,"../../../../..")]}},define:{"import.meta.env.VITE_TARGET":JSON.stringify("web")}});
