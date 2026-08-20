import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * 南孚官网那种「产品片」镜头：真实透视相机在三维场景里推拉，
 * 车从远处冲过来 → 略过近（铺满画面）→ 再拉远定格。
 *
 * 没有整车 GLB 模型（南孚自己也是预渲染 120 帧，不是实时建模），
 * 所以车身用抠好的透明贴图挂在三维平面上；3D 感来自：
 *   - 透视相机沿曲线运动（不是 CSS scale）
 *   - 路面网格沿 Z 轴往后退
 *   - 指数雾 + 星点粒子随深度消失
 *   - 定格后鼠标轻微视差
 */

interface Props {
  /** 0 = 开场，1 = 已定格；由父组件驱动，方便跳过时直接切到定格 */
  phase: 'rush' | 'hold'
  reducedMotion: boolean
}

const DURATION_MS = 4200

function easeOutExpo(t: number) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)
}
function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export default function Hero3D({ phase, reducedMotion }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      })
    } catch {
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x0a2034, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x0c2a42, 0.012)

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200)
    camera.position.set(0.15, 1.35, 10)

    const clock = new THREE.Clock()
    const startMs = performance.now()

    // —— 灯光：主光 + 青色轮廓光，金属车身才有高光层次 ——
    scene.add(new THREE.AmbientLight(0x8aa8b8, 0.72))
    const key = new THREE.DirectionalLight(0xffffff, 1.55)
    key.position.set(6, 8, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x3ae3ff, 0.55)
    rim.position.set(-8, 3, -2)
    scene.add(rim)
    const auroraFill = new THREE.DirectionalLight(0x4dff88, 0.55)
    auroraFill.position.set(-4, 10, -6)
    scene.add(auroraFill)
    const headGlow = new THREE.PointLight(0x3ae3ff, 2.6, 16, 2)
    headGlow.position.set(1.6, 0.9, -2.2)
    scene.add(headGlow)

    // —— 星点：远处粒子，随雾淡出 ——
    {
      const n = 420
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 80
        pos[i * 3 + 1] = Math.random() * 28 + 2
        pos[i * 3 + 2] = -Math.random() * 90 - 4
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const mat = new THREE.PointsMaterial({
        color: 0xcfe4ff,
        size: 0.07,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
      scene.add(new THREE.Points(geo, mat))
    }

    // —— 透视路面：shader 画虚线，uTime 往 -Z 滚，制造「路在脚下飞」——
    const roadUniforms = { uTime: { value: 0 } }
    const roadMat = new THREE.ShaderMaterial({
      uniforms: roadUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vPos;
        uniform float uTime;
        void main() {
          float z = vPos.z + uTime * 22.0;
          float x = vPos.x;
          // 中央虚线
          float dash = step(0.45, fract(z * 0.18));
          float center = (1.0 - smoothstep(0.04, 0.09, abs(x))) * dash;
          // 两侧车道线
          float side = (1.0 - smoothstep(0.025, 0.06, abs(abs(x) - 3.6))) * step(0.35, fract(z * 0.28));
          // 路面底色微弱网格
          float gridX = 1.0 - smoothstep(0.015, 0.04, abs(fract(x * 0.35) - 0.5));
          float gridZ = 1.0 - smoothstep(0.015, 0.04, abs(fract(z * 0.12) - 0.5));
          float grid = (gridX * 0.12 + gridZ * 0.08) * (1.0 - smoothstep(3.8, 8.0, abs(x)));
          float glow = center * 0.95 + side * 0.45 + grid;
          float fadeZ = 1.0 - smoothstep(-70.0, -8.0, vPos.z);
          float fadeX = 1.0 - smoothstep(7.5, 12.0, abs(x));
          vec3 col = mix(vec3(0.08, 0.12, 0.22), vec3(0.23, 0.89, 1.0), center);
          col = mix(col, vec3(0.85, 0.90, 1.0), side * 0.6);
          gl_FragColor = vec4(col, glow * fadeZ * fadeX);
        }
      `,
    })
    const road = new THREE.Mesh(new THREE.PlaneGeometry(24, 90, 1, 1), roadMat)
    road.rotation.x = -Math.PI / 2
    road.position.set(0, 0, -28)
    scene.add(road)

    // —— 极光：按参考图蓝绿调铺满上半天空，窗帘大幅漂移，够亮才看得见 ——
    const loader = new THREE.TextureLoader()
    const dummyTex = new THREE.Texture()
    const auroraUniforms = {
      uMap: { value: dummyTex },
      uTime: { value: 0 },
    }
    loader.load('/aurora.jpg', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      auroraUniforms.uMap.value = tex
      const mat = new THREE.ShaderMaterial({
        uniforms: auroraUniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            // 取样照片上 62% 天空，躲开山脚；UV 大幅漂移 = 风云变幻
            vec2 uv = vec2(vUv.x, 0.40 + vUv.y * 0.58);
            uv.x += sin(uTime * 0.22 + vUv.y * 2.8) * 0.045
                  + sin(uTime * 0.09 + vUv.y * 5.0) * 0.02;
            uv.y += sin(uTime * 0.16 + vUv.x * 2.1) * 0.03;
            vec3 c = texture2D(uMap, clamp(uv, 0.002, 0.998)).rgb;
            float pulse = 1.15 + 0.22 * sin(uTime * 0.48 + vUv.x * 2.6)
                        + 0.14 * sin(uTime * 0.95 + vUv.y * 4.5);
            c *= pulse;
            c.g *= 1.08 + 0.12 * sin(uTime * 0.7 + vUv.x * 3.4);
            c.b *= 1.10;
            float fade = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.78, vUv.y);
            gl_FragColor = vec4(c, fade);
          }
        `,
      })
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(150, 48), mat)
      sky.position.set(0, 18, -48)
      scene.add(sky)
    })

    // —— 卡车：透明贴图平面，放在三维世界里沿 Z 冲过来 ——
    const truckGroup = new THREE.Group()
    scene.add(truckGroup)

    const dummy = new THREE.Texture()
    const sweepUniforms = {
      uMap: { value: dummy },
      uSweep: { value: 0 },
    }
    loader.load('/truck-cutout.png', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
      sweepUniforms.uMap.value = tex
      const aspect = (tex.image?.width || 538) / (tex.image?.height || 312)
      const h = 2.55
      const w = h * aspect
      // 电流光：一团淡青绿从车尾滑到车头，不是横贯车身的死线
      const mat = new THREE.ShaderMaterial({
        uniforms: sweepUniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform float uSweep;
          varying vec2 vUv;
          void main() {
            vec4 c = texture2D(uMap, vUv);
            if (c.a < 0.08) discard;
            float body = smoothstep(0.02, 0.12, vUv.x) * smoothstep(0.88, 0.70, vUv.x)
                       * smoothstep(0.26, 0.36, vUv.y) * smoothstep(0.78, 0.64, vUv.y);
            float d = vUv.x - uSweep;
            float band = exp(-d * d * 28.0);
            float amount = band * body * 0.24;
            vec3 teal = vec3(0.42, 0.86, 0.80);
            gl_FragColor = vec4(c.rgb + teal * amount, c.a);
          }
        `,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
      mesh.position.y = h * 0.42
      truckGroup.add(mesh)
    })

    // 头灯光晕：加法混合的精灵，跟着车头
    const spriteMap = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 64
      const ctx = c.getContext('2d')!
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
      g.addColorStop(0, 'rgba(180,255,255,1)')
      g.addColorStop(0.35, 'rgba(58,227,255,0.55)')
      g.addColorStop(1, 'rgba(58,227,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 64, 64)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      return t
    })()
    const beam = new THREE.Sprite(new THREE.SpriteMaterial({
      map: spriteMap,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }))
    beam.scale.set(2.4, 1.1, 1)
    beam.position.set(1.55, 0.85, 0.15)
    truckGroup.add(beam)

    const mouse = { x: 0, y: 0 }
    const onMove = (e: PointerEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', onMove)

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth
      const h = canvas.clientHeight || window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    const look = new THREE.Vector3()
    const camPos = new THREE.Vector3()

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const t = clock.getDelta()
      const elapsed = performance.now() - startMs
      const rush = reducedMotion || phaseRef.current === 'hold'
        ? 1
        : easeOutExpo(Math.min(1, elapsed / DURATION_MS))

      // 车：从 Z=-48 冲到 Z=-3.2（远→近）
      const truckZ = THREE.MathUtils.lerp(-48, -3.2, rush)
      truckGroup.position.set(0.15, 0, truckZ)
      // 冲过来时略微抬头，定格时回正，避免一直像贴纸
      truckGroup.rotation.y = THREE.MathUtils.lerp(0.08, -0.04, rush)
      truckGroup.rotation.x = THREE.MathUtils.lerp(0.06, 0.0, rush)

      // 相机：先对着远方，车冲到跟前后再往右后拉（大→小定格）
      const pull = rush < 0.62 ? 0 : easeInOutCubic((rush - 0.62) / 0.38)
      camPos.set(
        THREE.MathUtils.lerp(0.05, 2.35, pull),
        THREE.MathUtils.lerp(1.15, 1.55, pull),
        THREE.MathUtils.lerp(9.2, 7.4, pull),
      )
      // 定格后鼠标视差（幅度很小，不抢车）
      if (rush >= 1) {
        camPos.x += mouse.x * 0.35
        camPos.y += -mouse.y * 0.18
      }
      camera.position.lerp(camPos, rush >= 1 ? 0.08 : 1)
      look.set(0.2 + pull * 0.4, 0.85, truckZ + 0.4)
      camera.lookAt(look)

      roadUniforms.uTime.value += t * (rush < 1 ? 1.15 : 0.35)
      auroraUniforms.uTime.value = elapsed * 0.001
      auroraFill.intensity = 0.35 + 0.18 * (0.5 + 0.5 * Math.sin(elapsed * 0.0009))
      headGlow.position.set(1.5, 0.9, truckZ + 0.8)
      // 车灯改回原来略暗的闪
      headGlow.intensity = 2.4 + Math.sin(elapsed * 0.004) * 0.5
      beam.material.opacity = 0.55 + Math.sin(elapsed * 0.005) * 0.15
      // 约 7 秒从车尾滑到车头
      sweepUniforms.uSweep.value = ((elapsed / 7000) % 1) * 1.15 - 0.08

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      renderer.dispose()
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Sprite) {
          obj.geometry?.dispose()
          const m = obj.material
          if (Array.isArray(m)) m.forEach((x) => x.dispose())
          else m?.dispose()
        }
      })
    }
  }, [reducedMotion])

  return <canvas ref={canvasRef} className="intro-canvas" />
}
