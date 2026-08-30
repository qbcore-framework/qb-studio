<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const visible = ref(false);
const title = ref("Vue resource UI");

function receiveMessage(event) {
  const message = event.data;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.type === "qb-studio:open") {
    if (typeof message.title === "string") title.value = message.title.slice(0, 80);
    visible.value = true;
  }
  if (message.type === "qb-studio:close") visible.value = false;
}

async function closeUi() {
  visible.value = false;
  const resourceName = typeof GetParentResourceName === "function" ? GetParentResourceName() : null;
  if (!resourceName) return;
  await fetch(`https://${resourceName}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

function onKeyDown(event) {
  if (event.key === "Escape" && visible.value) void closeUi();
}

onMounted(() => {
  window.addEventListener("message", receiveMessage);
  window.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", receiveMessage);
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <main class="overlay" :class="{ 'is-visible': visible }" :aria-hidden="!visible">
    <section class="panel" role="dialog" aria-modal="true" aria-labelledby="title">
      <p class="eyebrow">QB Studio Vue starter</p>
      <h1 id="title">{{ title }}</h1>
      <p>Edit <code>html/src/App.vue</code>, then run <code>npm run build</code> inside <code>html</code>.</p>
      <button type="button" @click="closeUi">Close</button>
    </section>
  </main>
</template>
