import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pointBudget, pixelRatio } from './state.mjs';
import { pointVertexShader, pointFragmentShader } from './shaders.mjs';

export class ScanScene {
  constructor(canvas, { lightMode, reducedMotion, onFailure }) {
    this.canvas = canvas;
    this.lightMode = lightMode;
    this.reducedMotion = reducedMotion;
    this.clouds = new Map();
    this.renderedClouds = new Set();
    this.renderedPoints = 0;
    this.renderedFrames = 0;
    this.dirty = true;
    this.failed = false;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x101212, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.debug.onShaderError = () => {
      this.failed = true;
      onFailure('Браузер не смог отрисовать облако точек. Попробуйте обновить браузер или включить аппаратное ускорение.', true);
    };
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.03, 1500);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(35, -45, 25);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = false;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 350;
    this.controls.minPolarAngle = 0.015;
    this.controls.maxPolarAngle = Math.PI - 0.015;
    this.controls.zoomSpeed = 0.75;
    this.controls.rotateSpeed = 0.55;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.failed = true;
      this.renderedPoints = 0;
      onFailure('Контекст WebGL потерян. Закройте лишние вкладки и перезагрузите просмотр.', true);
    });
    this.resize();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(pixelRatio(window.devicePixelRatio, this.lightMode));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width < height ? 66 : 50;
    // Keep the measured object above the lower mobile controls. This is a
    // projection/framing offset only; source XYZ and camera Z-up stay intact.
    if (width < height) this.camera.setViewOffset(width, height, 0, Math.round(height * 0.11), width, height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    for (const { points } of this.clouds.values()) {
      points.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
      points.material.uniforms.uProjectionScale.value = height * this.renderer.getPixelRatio() * this.camera.projectionMatrix.elements[5] / 2;
    }
    this.dirty = true;
  }

  clear() {
    for (const { points } of this.clouds.values()) {
      this.scene.remove(points);
      points.geometry.dispose();
      points.material.dispose();
    }
    this.clouds.clear();
    this.renderedClouds.clear();
    this.renderedPoints = 0;
    this.dirty = true;
  }

  addCloud(cloud, decoded) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(decoded.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(decoded.colors, 3));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...cloud.bounds.min), new THREE.Vector3(...cloud.bounds.max));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const material = new THREE.ShaderMaterial({
      vertexColors: true, vertexShader: pointVertexShader, fragmentShader: pointFragmentShader,
      uniforms: {
        uVisibility: { value: cloud.id === 'exterior' ? 1 : 0 },
        uClipZ: { value: cloud.bounds.max[2] + 1 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uProjectionScale: { value: window.innerHeight * this.renderer.getPixelRatio() * this.camera.projectionMatrix.elements[5] / 2 },
      },
      depthTest: true, depthWrite: true, transparent: false, toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = cloud.id;
    points.onAfterRender = () => this.renderedClouds.add(cloud.id);
    this.clouds.set(cloud.id, { points, cloud });
    this.scene.add(points);
    this.applyBudget(points, cloud.pointCount);
    this.dirty = true;
  }

  applyBudget(points, count) {
    const budget = pointBudget(count, this.lightMode);
    if (budget < count) {
      // Evenly cover the entire measured cloud instead of showing its first
      // spatially ordered records. No new or interpolated points are created.
      const indices = new Uint32Array(budget);
      for (let i = 0; i < budget; i++) indices[i] = Math.floor(i * count / budget);
      points.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    } else points.geometry.setIndex(null);
    points.geometry.setDrawRange(0, budget);
  }

  setQuality(lightMode) {
    this.lightMode = lightMode;
    for (const { points, cloud } of this.clouds.values()) this.applyBudget(points, cloud.pointCount);
    this.resize();
  }

  setFree(enabled) {
    this.controls.enableDamping = false;
    this.controls.update(); // flush any residual orbit delta before route owns camera
    this.controls.enabled = enabled;
    this.controls.enableDamping = enabled && !this.reducedMotion;
    this.canvas.style.touchAction = enabled ? 'none' : 'pan-y';
    this.dirty = true;
  }

  getPose() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  setPose(pose) {
    this.camera.position.fromArray(pose.position);
    this.controls.target.fromArray(pose.target);
    this.camera.lookAt(this.controls.target);
    this.dirty = true;
  }

  setCloudState(pose, sliceHeight) {
    for (const [id, { points }] of this.clouds) {
      const visibility = pose[id];
      const clipZ = id === 'interior' ? sliceHeight : 1000000;
      if (Math.abs(points.material.uniforms.uVisibility.value - visibility) > 1e-6 || points.material.uniforms.uClipZ.value !== clipZ) this.dirty = true;
      points.material.uniforms.uVisibility.value = visibility;
      points.material.uniforms.uClipZ.value = clipZ;
      points.visible = visibility > 0.001;
    }
  }

  keyboardOrbit(key, shiftKey) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const rotation = new THREE.Quaternion().setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
    const spherical = new THREE.Spherical().setFromVector3(offset.clone().applyQuaternion(rotation));
    if (key === '+' || key === '=') spherical.radius *= 0.86;
    else if (key === '-' || key === '_') spherical.radius *= 1.16;
    else if (shiftKey) {
      const axis = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, key === 'ArrowLeft' || key === 'ArrowRight' ? 0 : 1);
      const sign = key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 1;
      const delta = axis.multiplyScalar(sign * spherical.radius * 0.05);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.controls.update();
      this.dirty = true;
      return;
    } else if (key === 'ArrowLeft') spherical.theta += 0.09;
    else if (key === 'ArrowRight') spherical.theta -= 0.09;
    else if (key === 'ArrowUp') spherical.phi -= 0.09;
    else if (key === 'ArrowDown') spherical.phi += 0.09;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.015, Math.PI - 0.015);
    spherical.radius = THREE.MathUtils.clamp(spherical.radius, this.controls.minDistance, this.controls.maxDistance);
    offset.setFromSpherical(spherical).applyQuaternion(rotation.invert());
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.dirty = true;
  }

  render() {
    if (this.failed || this.renderer.getContext().isContextLost()) return false;
    if (this.controls.enabled) this.controls.update();
    if (!this.dirty) return false;
    this.renderer.render(this.scene, this.camera);
    this.renderedPoints = this.renderer.info.render.points;
    this.renderedFrames++;
    this.dirty = false;
    return !this.failed && this.renderedPoints > 0 && this.renderer.info.render.calls > 0;
  }
}
