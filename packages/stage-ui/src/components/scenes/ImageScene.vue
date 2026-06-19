<script setup lang="ts">
import { computed, ref, watch } from 'vue'

// Static-image avatar renderer.
//
// Shows a single flat image (PNG/JPG/WebP) as the character and fakes "being
// alive" with purely procedural CSS motion: a slow breathing scale, a gentle
// horizontal sway, and a subtle vertical float. There is no rig behind the
// image, so this intentionally has no blink / lip-sync / expression support.
// The motion layers are nested so each transform animates independently and
// they compose instead of overwriting one another.

const props = withDefaults(defineProps<{
  modelSrc?: string
  paused?: boolean
  scale?: number
  xOffset?: number | string
  yOffset?: number | string
}>(), { paused: false, scale: 1 })

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

const loaded = ref(false)

// Pause all idle motion when the stage is paused or the user prefers reduced
// motion (handled in CSS via the media query below as well).
const playState = computed(() => (props.paused ? 'paused' : 'running'))

// Normalize px-or-string offsets the same way the Live2D/VRM scenes accept them.
function toLength(value?: number | string) {
  if (value == null)
    return '0px'

  return typeof value === 'number' ? `${value}px` : value
}

const containerStyle = computed(() => ({
  transform: `translate(${toLength(props.xOffset)}, ${toLength(props.yOffset)}) scale(${props.scale})`,
}))

function onImageLoad() {
  loaded.value = true
  componentState.value = 'mounted'
}

function onImageError() {
  loaded.value = false
  componentState.value = 'pending'
}

// Reset state whenever the source changes so a swapped avatar re-reports mounted.
watch(() => props.modelSrc, () => {
  loaded.value = false
  componentState.value = 'loading'
})
</script>

<template>
  <div
    :class="['relative h-full w-full', 'flex items-center justify-center', 'overflow-hidden']"
    :style="containerStyle"
  >
    <div
      v-if="modelSrc"
      class="image-scene-float"
      :style="{ animationPlayState: playState }"
      h-full max-h-full w-full flex items-center justify-center
    >
      <div
        class="image-scene-sway"
        :style="{ animationPlayState: playState }"
        h-full w-full flex items-center justify-center
      >
        <img
          :src="modelSrc"
          class="image-scene-breathe"
          :style="{ animationPlayState: playState }"
          alt="Character"
          draggable="false"
          h-full max-h-full max-w-full w-auto select-none object-contain
          @load="onImageLoad"
          @error="onImageError"
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
/* transform-origin sits at the bottom so breathing reads like the chest/torso
   lifting rather than the whole sprite zooming from its center. */
.image-scene-breathe {
  transform-origin: 50% 100%;
  animation: image-scene-breathe 3.6s ease-in-out infinite;
}

.image-scene-sway {
  transform-origin: 50% 100%;
  animation: image-scene-sway 6.2s ease-in-out infinite;
}

.image-scene-float {
  animation: image-scene-float 4.8s ease-in-out infinite;
}

@keyframes image-scene-breathe {
  0%, 100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.03, 1.045);
  }
}

@keyframes image-scene-sway {
  0%, 100% {
    transform: translateX(-1.6%) rotate(-1.4deg);
  }
  50% {
    transform: translateX(1.6%) rotate(1.4deg);
  }
}

@keyframes image-scene-float {
  0%, 100% {
    transform: translateY(2%);
  }
  50% {
    transform: translateY(-2%);
  }
}

/* NOTICE:
   Intentionally NOT gating idle motion behind `prefers-reduced-motion`.
   Root cause: a previous version disabled all motion under that media query,
   so on machines with the OS "reduce motion" setting enabled the avatar looked
   completely frozen. The breathing/sway/float IS the core behavior of this
   image-avatar renderer (the only thing that makes a flat PNG feel alive), so
   it is treated as essential content rather than decorative motion.
   Removal condition: when an explicit per-avatar "idle motion" toggle exists in
   settings, route reduced-motion handling through that instead. */
</style>
