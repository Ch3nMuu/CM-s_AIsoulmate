(function () {
    'use strict';

    const INDEX_URL = 'character_images/index.json';
    let assetIndex = [];
    let indexLoadPromise = null;

    function emptyVisualMemory(id = '') {
        return { id: String(id || ''), referenceImages: [], imageCount: 0 };
    }

    function normalizeIndexEntry(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const visualFolder = String(entry.visualFolder || entry.id || '').trim();
        const id = String(entry.id || visualFolder).trim();
        if (!id || !visualFolder) return null;
        return {
            id,
            name: String(entry.name || '').trim(),
            visualFolder,
            referenceImages: Array.isArray(entry.referenceImages)
                ? entry.referenceImages.filter(path => typeof path === 'string' && path.trim())
                : []
        };
    }

    function resolveAssetPath(visualFolder, imagePath) {
        const value = String(imagePath || '').trim();
        if (!value) return '';
        if (/^(?:data:|blob:|https?:\/\/)/i.test(value)) return value;
        if (value.startsWith('character_images/')) return value;
        const relative = value.replace(/^\.\//, '');
        const folder = encodeURIComponent(String(visualFolder));
        return `character_images/${folder}/${relative.startsWith('reference/') ? relative : `reference/${relative}`}`;
    }

    async function loadAssetIndex(force = false) {
        if (!force && assetIndex.length) return assetIndex;
        if (!force && indexLoadPromise) return indexLoadPromise;
        indexLoadPromise = fetch(INDEX_URL, { cache: 'no-cache' })
            .then(response => {
                if (!response.ok) throw new Error(`视觉资料索引加载失败 (${response.status})`);
                return response.json();
            })
            .then(data => {
                const entries = Array.isArray(data) ? data : [];
                assetIndex = entries.map(normalizeIndexEntry).filter(Boolean);
                return assetIndex;
            })
            .catch(error => {
                console.warn('[CharacterVisualMemory]', error.message);
                assetIndex = [];
                return assetIndex;
            })
            .finally(() => { indexLoadPromise = null; });
        return indexLoadPromise;
    }

    function findIndexEntry(character, index = assetIndex) {
        if (!character) return null;
        const explicitVisualId = String(
            character.characterVisualId || character.visualMemory?.id || ''
        ).trim();
        const characterId = String(character.id || '').trim();
        const names = [character.name, character.remark]
            .map(value => String(value || '').trim())
            .filter(Boolean);

        return index.find(entry => explicitVisualId && (
            entry.id === explicitVisualId || entry.visualFolder === explicitVisualId
        )) || index.find(entry => characterId && (
            entry.id === characterId || entry.visualFolder === characterId
        )) || index.find(entry => entry.name && names.includes(entry.name)) || null;
    }

    function createVisualMemory(entry) {
        if (!entry) return emptyVisualMemory();
        const referenceImages = entry.referenceImages
            .map(path => resolveAssetPath(entry.visualFolder, path))
            .filter(Boolean);
        return { id: entry.id, referenceImages, imageCount: referenceImages.length };
    }

    async function hydrateCharacter(character) {
        if (!character || character.isGroup) return character;
        const index = await loadAssetIndex();
        const entry = findIndexEntry(character, index);
        character.visualMemory = createVisualMemory(entry);
        character.characterVisualId = entry ? entry.id : '';
        return character;
    }

    async function hydrateCharacters(characters = []) {
        if (!Array.isArray(characters)) return characters;
        await loadAssetIndex();
        characters.forEach(character => {
            if (!character || character.isGroup) return;
            const entry = findIndexEntry(character);
            character.visualMemory = createVisualMemory(entry);
            character.characterVisualId = entry ? entry.id : '';
        });
        return characters;
    }

    function getDetectedResources() {
        return assetIndex.map(entry => ({
            id: entry.id,
            name: entry.name,
            visualFolder: entry.visualFolder,
            imageCount: entry.referenceImages.length
        }));
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('参考图片读取失败'));
            reader.readAsDataURL(blob);
        });
    }

    async function loadReferenceImages(character, limit = 6) {
        await hydrateCharacter(character);
        const paths = (character?.visualMemory?.referenceImages || []).slice(0, Math.max(0, limit));
        const images = [];
        for (const path of paths) {
            try {
                const response = await fetch(path, { cache: 'force-cache' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                images.push(await blobToDataUrl(await response.blob()));
            } catch (error) {
                console.warn('[CharacterVisualMemory] reference image skipped:', path, error.message);
            }
        }
        return images;
    }

    async function init() {
        await loadAssetIndex();
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (typeof friends !== 'undefined' && Array.isArray(friends)) {
                await hydrateCharacters(friends);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    window.CharacterVisualMemory = {
        INDEX_URL,
        emptyVisualMemory,
        normalizeIndexEntry,
        resolveAssetPath,
        loadAssetIndex,
        findIndexEntry,
        createVisualMemory,
        hydrateCharacter,
        hydrateCharacters,
        getDetectedResources,
        loadReferenceImages,
        init
    };

    void init();
}());
