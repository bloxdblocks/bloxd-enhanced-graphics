
/**
 * enhanced_realism_module.js
 *
 * Developer-ready ES module for integrating enhanced graphics into a NOA + BabylonJS game (e.g., Bloxd.io).
 * Exported function: enableEnhancedGraphics(noa, scene, camera, engine, options = {})
 *
 * Place this file in the game's client codebase and import it where the renderer is initialized.
 *
 * Note about LOCAL_SHADER_FILE:
 * The original user-uploaded path was provided as a hint: /mnt/data/shaders.py
 * In most production environments that path won't be fetchable from the browser; the developer can
 * provide a server URL or inline the contents instead. The module will attempt fetch() only if the
 * provided localShaderUrl is reachable in the runtime environment.
 *
 * Usage example (ES module):
 * import { enableEnhancedGraphics } from './enhanced_realism_module.js';
 * enableEnhancedGraphics(noa, scene, camera, engine, { /* options * / });
 */

export async function enableEnhancedGraphics(noa, scene, camera, engine, options = {}) {
    if (!noa || !scene || !camera) {
        console.warn("EnhancedRealism: missing required engine objects (noa, scene, camera). Aborting.");
        return;
    }
    // Merge default config with user-supplied options
    const CONFIG = Object.assign({
        // Shadows
        enableShadows: true,
        shadowResolution: 2048,
        shadowDistance: 120,
        shadowQuality: "HIGH", // LOW | MEDIUM | HIGH

        // Postprocessing
        enableBloom: true,
        bloomWeight: 0.6,
        bloomThreshold: 0.85,

        enableToneMap: true,
        exposure: 1.15,

        // SSAO
        enableSSAO: true,
        ssaoRatio: 0.6,
        ssaoBlurRatio: 0.5,

        // Motion blur (optional)
        enableMotionBlur: false,
        motionBlurStrength: 0.8,

        // Volumetric light scattering (glare)
        enableGlare: true,

        // Clouds
        enableClouds: true,
        cloudTextureUrl: null, // provide URL to a tileable cloud PNG to improve visuals
        cloudsSize: 1800,
        cloudsAltitude: 180,
        cloudsSpeed: 0.0006,

        // High-res textures
        enableHighResTextures: false,
        textureMap: {},

        // Local shader file - developer hint from user-uploaded file path.
        // Note: this path is likely not fetchable from a browser; replace with a server URL if needed.
        localShaderUrl: "/mnt/data/shaders.py",

        // Internal
        debugLog: false
    }, options);

    function log(...args) { if (CONFIG.debugLog) console.log("EnhancedRealism:", ...args); }

    // Helpers
    const BABYLON = window.BABYLON || (scene && scene.getEngine && scene.getEngine()._babylonNamespace) || null;
    if (!BABYLON) {
        console.warn("EnhancedRealism: BabylonJS not detected on window. Module expects Babylon to be available.");
    }

    // Try to load local shader file (if reachable). This is best-effort and fails silently.
    async function tryLoadLocalShader(url) {
        if (!url) return;
        try {
            const resp = await fetch(url, {cache: "no-store"});
            if (!resp.ok) { log("local shader file not fetchable:", url, resp.status); return; }
            const text = await resp.text();
            if (text && text.trim().length > 20) {
                // Only eval if looks like JS - keep it guarded
                try {
                    (0,eval)(text);
                    log("Loaded local shader file:", url);
                } catch (err) {
                    // Might be python file or not JS; ignore
                    log("Local shader eval failed (likely non-JS):", err);
                }
            }
        } catch (e) {
            log("fetch local shader failed:", e);
        }
    }
    tryLoadLocalShader(CONFIG.localShaderUrl).catch(()=>{});

    // SECTION: Cascaded Shadows
    let cascadedGen = null;
    if (CONFIG.enableShadows && BABYLON && BABYLON.CascadedShadowGenerator && noa.rendering && noa.rendering.light) {
        try {
            const light = noa.rendering.light;
            const cam = camera;
            const res = CONFIG.shadowResolution;
            cascadedGen = new BABYLON.CascadedShadowGenerator(res, light, true, cam);

            cascadedGen.shadowMaxZ = CONFIG.shadowDistance;
            cascadedGen.lambda = 0.12;
            cascadedGen.filteringQuality = BABYLON.CascadedShadowGenerator.QUALITY_HIGH;
            cascadedGen.forceBackFacesOnly = true;
            cascadedGen.transparencyShadow = false;
            cascadedGen.darkness = 0.45;

            cascadedGen.autoCalcDepthBounds = false;
            cascadedGen.freezeShadowCastersBoundingInfo = true;
            cascadedGen.shadowCastersBoundingInfo.reConstruct(
                new BABYLON.Vector3(-CONFIG.shadowDistance, -CONFIG.shadowDistance, -CONFIG.shadowDistance),
                new BABYLON.Vector3(CONFIG.shadowDistance, CONFIG.shadowDistance, CONFIG.shadowDistance)
            );

            if (CONFIG.shadowQuality === "LOW") {
                cascadedGen.filteringQuality = BABYLON.CascadedShadowGenerator.QUALITY_LOW;
                cascadedGen.shadowMaxZ = Math.min(80, cascadedGen.shadowMaxZ);
                cascadedGen.darkness = 0.35;
            } else if (CONFIG.shadowQuality === "MEDIUM") {
                cascadedGen.filteringQuality = BABYLON.CascadedShadowGenerator.QUALITY_HIGH;
                cascadedGen.shadowMaxZ = Math.min(110, cascadedGen.shadowMaxZ);
            }

            // Attach/Detach shadows as meshes are added/removed
            function setMeshShadows(mesh, forceRemove = false) {
                if (!mesh || !mesh.position) return;
                if (!mesh.metadata) mesh.metadata = {};
                const has = !!mesh.metadata._hasShadows;
                const need = forceRemove ? false : (mesh.position.length() < CONFIG.shadowDistance);
                if (has === need) return;
                if (need) {
                    try { cascadedGen.addShadowCaster(mesh, true); } catch (e) {}
                    if (!mesh.isAnInstance) mesh.receiveShadows = true;
                } else {
                    try { cascadedGen.removeShadowCaster(mesh, true); } catch (e) {}
                    if (!mesh.isAnInstance) mesh.receiveShadows = false;
                }
                mesh.metadata._hasShadows = need;
                if (mesh.resetDrawCache) mesh.resetDrawCache();
            }

            noa.on("addingTerrainMesh", mesh => setMeshShadows(mesh));
            noa.on("removingTerrainMesh", mesh => setMeshShadows(mesh, true));

            // Progressive check per tick to avoid stalls
            let checkIx = 0;
            noa.on("tick", () => {
                const meshes = scene.meshes || [];
                const count = Math.min(20, Math.floor(meshes.length / 5));
                for (let i = 0; i < count; i++) {
                    if (checkIx >= meshes.length) checkIx = 0;
                    setMeshShadows(meshes[checkIx++]);
                }
            });
            log("Cascaded shadows configured.");
        } catch (e) {
            console.warn("EnhancedRealism: failed to create cascaded shadow generator:", e);
        }
    } else {
        log("Cascaded shadows not enabled or not available.");
    }

    // SECTION: Post-processing pipeline (bloom, tonemap, motion blur) using DefaultRenderingPipeline
    let defaultPipeline = null;
    try {
        if (BABYLON && BABYLON.DefaultRenderingPipeline) {
            defaultPipeline = new BABYLON.DefaultRenderingPipeline("erp_default_pipeline", true, scene, [camera]);

            defaultPipeline.bloomEnabled = !!CONFIG.enableBloom;
            defaultPipeline.bloomWeight = CONFIG.bloomWeight;
            defaultPipeline.bloomKernel = 64;
            defaultPipeline.bloomThreshold = CONFIG.bloomThreshold;

            defaultPipeline.imageProcessingEnabled = !!CONFIG.enableToneMap;
            if (scene.imageProcessingConfiguration) {
                scene.imageProcessingConfiguration.toneMappingEnabled = !!CONFIG.enableToneMap;
                scene.imageProcessingConfiguration.exposure = CONFIG.exposure;
                if (scene.imageProcessingConfiguration.contrast !== undefined) {
                    scene.imageProcessingConfiguration.contrast = 1.02;
                }
            }

            if (CONFIG.enableMotionBlur && defaultPipeline.motionBlur) {
                defaultPipeline.motionBlurEnabled = true;
                defaultPipeline.motionStrength = CONFIG.motionBlurStrength;
            } else {
                try { defaultPipeline.motionBlurEnabled = false; } catch (e) {}
            }

            log("DefaultRenderingPipeline configured.");
        } else {
            log("DefaultRenderingPipeline not available in Babylon build.");
        }
    } catch (e) {
        console.warn("EnhancedRealism: error configuring DefaultRenderingPipeline:", e);
    }

    // SECTION: SSAO (SSAO2RenderingPipeline)
    let ssaoPipeline = null;
    try {
        if (CONFIG.enableSSAO && BABYLON && BABYLON.SSAO2RenderingPipeline) {
            ssaoPipeline = new BABYLON.SSAO2RenderingPipeline("ssao", scene, {
                ssaoRatio: CONFIG.ssaoRatio,
                blurRatio: CONFIG.ssaoBlurRatio
            }, [camera]);

            ssaoPipeline.fallOff = 0.0001;
            ssaoPipeline.radius = 2.0;
            ssaoPipeline.totalStrength = 1.0;
            ssaoPipeline.expensiveBlur = true;
            if (CONFIG.shadowQuality === "LOW") {
                ssaoPipeline.totalStrength = 0.6;
                ssaoPipeline.expensiveBlur = false;
            }
            log("SSAO enabled.");
        } else {
            log("SSAO pipeline not available or disabled.");
        }
    } catch (e) {
        console.warn("EnhancedRealism: error configuring SSAO:", e);
    }

    // SECTION: Volumetric glare (VolumetricLightScatteringPostProcess) - cheap helper
    try {
        if (CONFIG.enableGlare && BABYLON && BABYLON.VolumetricLightScatteringPostProcess && noa.rendering && noa.rendering.light) {
            const sunMesh = BABYLON.MeshBuilder.CreateSphere("__erp_sun_helper", { diameter: 2 }, scene);
            sunMesh.material = new BABYLON.StandardMaterial("erp_sun_helper_mat", scene);
            sunMesh.isVisible = false;
            const light = noa.rendering.light;
            // Position helper far along light direction relative to camera
            try {
                const dir = light.getDirection ? light.getDirection() : new BABYLON.Vector3(0, -1, 0);
                sunMesh.position = camera.position.add(dir.scale(1000));
            } catch (e) {
                sunMesh.position = camera.position.add(new BABYLON.Vector3(0, 400, 0));
            }

            const vls = new BABYLON.VolumetricLightScatteringPostProcess("vls", 1.0, camera, sunMesh, 50, BABYLON.Texture.BILINEAR_SAMPLINGMODE, engine, false);
            vls.exposure = 0.2;
            vls.decay = 0.95;
            vls.weight = 0.6;
            vls.density = 0.8;
            log("Volumetric light scattering added.");
        } else {
            log("Volumetric light scattering not available or disabled.");
        }
    } catch (e) {
        console.warn("EnhancedRealism: Volumetric glare init failed:", e);
    }

    // SECTION: Lightweight clouds layer
    let cloudsMesh = null;
    try {
        if (CONFIG.enableClouds && BABYLON) {
            const CLOUD_TEXTURE = CONFIG.cloudTextureUrl || null;
            cloudsMesh = BABYLON.MeshBuilder.CreatePlane("__erp_clouds", { width: CONFIG.cloudsSize, height: CONFIG.cloudsSize }, scene);
            const cloudMat = new BABYLON.StandardMaterial("__erp_clouds_mat", scene);
            cloudMat.backFaceCulling = false;
            cloudMat.disableLighting = true;
            cloudMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;

            if (CLOUD_TEXTURE) {
                cloudMat.diffuseTexture = new BABYLON.Texture(CLOUD_TEXTURE, scene, true, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
                cloudMat.diffuseTexture.uScale = 6;
                cloudMat.diffuseTexture.vScale = 6;
                cloudMat.diffuseTexture.hasAlpha = true;
            } else {
                const dt = new BABYLON.DynamicTexture("__erp_cloud_dyn", {width:512, height:512}, scene, false);
                const ctx = dt.getContext();
                const g = ctx.createLinearGradient(0,0,512,512);
                g.addColorStop(0, "rgba(255,255,255,0.9)");
                g.addColorStop(1, "rgba(255,255,255,0.05)");
                ctx.fillStyle = g;
                ctx.fillRect(0,0,512,512);
                for (let i=0;i<12;i++){
                    ctx.globalAlpha = 0.18;
                    ctx.beginPath();
                    ctx.arc(Math.random()*512, Math.random()*512, 60 + Math.random()*120, 0, Math.PI*2);
                    ctx.fill();
                }
                dt.update();
                cloudMat.diffuseTexture = dt;
                cloudMat.diffuseTexture.uScale = 3;
                cloudMat.diffuseTexture.vScale = 3;
                cloudMat.alpha = 0.7;
            }

            cloudsMesh.material = cloudMat;
            cloudsMesh.rotation.x = Math.PI / 2;
            cloudsMesh.position.y = CONFIG.cloudsAltitude;

            scene.registerBeforeRender(() => {
                const camPos = camera.position;
                cloudsMesh.position.x = camPos.x;
                cloudsMesh.position.z = camPos.z;
                const dt = cloudMat.diffuseTexture;
                if (dt) {
                    dt.uOffset = (dt.uOffset || 0) + CONFIG.cloudsSpeed * (engine ? engine.getDeltaTime() : 16.67);
                }
            });
            log("Cloud layer created.");
        } else {
            log("Clouds disabled or Babylon missing.");
        }
    } catch (e) {
        console.warn("EnhancedRealism: cloud layer failed:", e);
    }

    // SECTION: High-res texture injection (Image src interceptor)
    if (CONFIG.enableHighResTextures && CONFIG.textureMap && Object.keys(CONFIG.textureMap).length > 0) {
        try {
            const OrigImage = window.Image;
            window.Image = function() {
                const img = new OrigImage();
                const setSrc = Object.getOwnPropertyDescriptor(OrigImage.prototype, "src").set;
                Object.defineProperty(img, "src", {
                    set(value) {
                        if (typeof value === "string") {
                            for (const key in CONFIG.textureMap) {
                                if (!Object.prototype.hasOwnProperty.call(CONFIG.textureMap, key)) continue;
                                if (value.indexOf(key) !== -1) {
                                    value = CONFIG.textureMap[key];
                                    break;
                                }
                            }
                        }
                        setSrc.call(this, value);
                    },
                    get() { return img.src; },
                    configurable: true,
                    enumerable: true
                });
                return img;
            };
            log("Image src hook for high-res textures installed.");
        } catch (e) {
            console.warn("EnhancedRealism: failed to install image hook:", e);
        }
    } else {
        log("High-res textures disabled or textureMap empty.");
    }

    // Final lighting tweaks
    try {
        scene.ambientColor = new BABYLON.Color3(0.36, 0.36, 0.36);
        if (noa.rendering && noa.rendering.light) {
            const light = noa.rendering.light;
            try {
                light.intensity = Math.min(1.25, (light.intensity || 1) * 1.05);
                light.diffuse = new BABYLON.Color3(1.0, 0.98, 0.92);
            } catch (e) {}
        }
    } catch (e) {}

    // Expose runtime toggles
    const api = {
        config: CONFIG,
        setTextureMap(m) { CONFIG.textureMap = m; },
        setCloudTexture(url) { CONFIG.cloudTextureUrl = url; },
        reloadWithOptions(newOpts = {}) { Object.assign(CONFIG, newOpts); location.reload(); }
    };
    // attach to window for console tweaking if available
    if (typeof window !== "undefined") window.EnhancedRealismModule = api;
    log("EnhancedRealism module initialized.");

    return api;
}
