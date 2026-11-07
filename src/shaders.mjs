export const pointVertexShader = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uProjectionScale;
  varying vec3 vScanColor;
  varying float vHeight;
  varying float vSeed;
  void main() {
    vScanColor = color;
    vHeight = position.z;
    vSeed = fract(sin(dot(position, vec3(12.9898, 78.233, 41.158))) * 43758.5453);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(0.024 * uProjectionScale / max(0.1, -viewPosition.z), 1.35 * uPixelRatio, 4.25 * uPixelRatio);
  }
`;

export const pointFragmentShader = /* glsl */ `
  uniform float uVisibility;
  uniform float uClipZ;
  varying vec3 vScanColor;
  varying float vHeight;
  varying float vSeed;
  void main() {
    if (vHeight > uClipZ || vSeed >= uVisibility) discard;
    vec2 radius = gl_PointCoord - 0.5;
    if (dot(radius, radius) > 0.25) discard;
    // Colors were decoded from source sRGB into Linear-sRGB in the worker.
    // Only the output transform is applied here; no lighting or tone mapping.
    gl_FragColor = vec4(vScanColor, 1.0);
    #include <colorspace_fragment>
  }
`;
