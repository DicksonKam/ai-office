// Light a plain lamp cannot give, added to every lit material's shader at one place (so it reaches merged and dimmed copies too):
//   indoors   an even light that exists only inside the building, so the room can be bright without touching the garden
//   windows   sky light falling off into the room from every opening in the list (openings.js): a new window brings its own
//   bounce    sun off the ground onto the sides of things. It reads the sun's shadow map just beside each face, so a car's side
//             dims inside a building's shadow; faint indoors, where a patch of sun gently lights what stands next to it.
// How strong the sky is comes from the hemisphere light, and the sun from the sun light itself: nothing here is told the time.
import * as THREE from 'three';
import { FLOOR_H } from './office.js';

const MAX_WINDOWS = 16;
const INDOORS = 0.62, WINDOW_SKY = 1.5, BOUNCE = 0.45, BOUNCE_INDOORS = 0.17;
const windowAt = Array.from({ length: MAX_WINDOWS }, () => new THREE.Vector4()), windowIn = Array.from({ length: MAX_WINDOWS }, () => new THREE.Vector3());
const indoorBox = new THREE.Vector2(), uniforms = { windowAt: { value: windowAt }, windowIn: { value: windowIn }, indoorBox: { value: indoorBox } };

for (const id of ['toon', 'standard', 'physical', 'lambert', 'phong']) Object.assign(THREE.ShaderLib[id].uniforms, uniforms);

THREE.ShaderChunk.lights_pars_begin += /* glsl */`
uniform vec4 windowAt[${MAX_WINDOWS}];
uniform vec3 windowIn[${MAX_WINDOWS}];
uniform vec2 indoorBox;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
`;
THREE.ShaderChunk.lights_fragment_end += /* glsl */`
{
  mat3 toWorld = transpose( mat3( viewMatrix ) );
  vec3 worldN = toWorld * normal, worldP = toWorld * ( - vViewPosition - viewMatrix[ 3 ].xyz ), extra = vec3( 0.0 );
  float day = 1.0;
  #if NUM_HEMI_LIGHTS > 0
  vec3 sky = hemisphereLights[ 0 ].skyColor;
  float skyLevel = dot( sky, vec3( 0.3333 ) );
  day = smoothstep( 0.33, 0.64, skyLevel ); // full by day; falls away through the evening, so the lamps take over the room
  if ( day > 0.0 && abs( worldP.x ) < indoorBox.x && abs( worldP.z ) < indoorBox.y ) {
    vec3 tint = sky / max( skyLevel, 0.01 ) * vec3( 1.0, 0.97, 0.92 );
    extra += ${INDOORS.toFixed(3)} * day * tint * ( 0.75 + 0.35 * dot( worldN, vec3( 0.5, 0.4, 0.6 ) ) );
    float inFloor = mod( worldP.y, ${FLOOR_H.toFixed(3)} ), fromWindows = 0.0;
    for ( int i = 0; i < ${MAX_WINDOWS}; i ++ ) {
      if ( windowAt[ i ].w <= 0.0 ) break;
      vec3 toWindow = windowAt[ i ].xyz - vec3( worldP.x, inFloor, worldP.z );
      float dist2 = dot( toWindow, toWindow ), dist = sqrt( max( dist2, 0.0001 ) );
      fromWindows += windowAt[ i ].w * max( dot( - toWindow, windowIn[ i ] ), 0.0 ) / dist * max( dot( worldN, toWindow ), 0.0 ) / dist / ( dist2 + 1.0 );
    }
    extra += ${WINDOW_SKY.toFixed(3)} * day * sky * fromWindows;
  }
  #endif
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if ( receiveShadow && worldN.y < 0.6 ) {
    float sunUp = max( ( toWorld * directionalLights[ 0 ].direction ).y, 0.0 );
    if ( sunUp > 0.01 && day > 0.0 ) { // moonlight off the ground is too faint to matter, and on walls its sample came out as speckle
      bool inside = abs( worldP.x ) < indoorBox.x && abs( worldP.z ) < indoorBox.y;
      vec3 beside = worldP + vec3( worldN.x, 0.0, worldN.z ) * ( inside ? 0.7 : 2.4 ) - vec3( 0.0, 0.2, 0.0 ); // outdoors, past the thing's own shadow: the ground this face looks at
      float lit = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, 1.0, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, directionalShadowMatrix[ 0 ] * vec4( beside, 1.0 ) );
      extra += ${BOUNCE.toFixed(3)} * ( inside ? ${BOUNCE_INDOORS.toFixed(3)} : 1.0 ) * ( 1.0 - max( worldN.y, 0.0 ) ) * sunUp * day * lit * directionalLights[ 0 ].color; // indoors faint: a sharp sunbeam just beside a wall must not print on it
    }
  }
  #endif
  reflectedLight.directDiffuse += extra * BRDF_Lambert( material.diffuseColor );
}
`;

/** Tell the shader where the building and its openings are. Every floor has the same plan, so one list serves them all. */
export function setBuilding(office) {
  indoorBox.set(office.hx, office.hz);
  const inward = { back: [0, 0, 1], front: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] };
  const list = (office.openings || []).filter(o => o.light !== false).slice(0, MAX_WINDOWS);
  windowAt.forEach((v, i) => {
    const o = list[i];
    if (!o) { v.set(0, 0, 0, 0); return; }
    const onBack = o.wall === 'back' || o.wall === 'front', side = o.wall === 'back' || o.wall === 'west' ? -1 : 1;
    v.set(onBack ? o.at : side * office.hx, (o.sill + o.top) / 2, onBack ? side * office.hz : o.at, o.w * (o.top - o.sill));
    windowIn[i].fromArray(inward[o.wall]);
  });
}
