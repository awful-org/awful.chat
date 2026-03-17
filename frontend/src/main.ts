import { mount } from "svelte";
import { registerSW } from 'virtual:pwa-register'
import "./app.css";
import App from "./App.svelte";

registerSW({
  onNeedRefresh() {
    console.log('New content available, refresh to update')
  },
  onOfflineReady() {
    console.log('App ready to work offline')
  },
})

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
