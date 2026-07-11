(function () {
    'use strict';

    let currentSource = '';
    let scale = 1;
    let startDistance = 0;
    let startScale = 1;

    function ensureViewer() {
        if (document.getElementById('jrsyImageViewer')) return;
        const style = document.createElement('style');
        style.textContent = `
            #jrsyImageViewer{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.94);display:none;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
            #jrsyImageViewer.open{display:flex}
            #jrsyImageViewer img{max-width:100vw;max-height:100vh;object-fit:contain;transform-origin:center;transition:transform .12s ease;user-select:none;-webkit-user-drag:none}
            .jrsy-viewer-actions{position:absolute;left:0;right:0;top:max(16px,env(safe-area-inset-top));display:flex;justify-content:space-between;padding:12px 18px;z-index:2}
            .jrsy-viewer-btn{border:0;border-radius:22px;background:rgba(40,40,40,.75);color:#fff;padding:10px 16px;font-size:15px;backdrop-filter:blur(8px)}
        `;
        document.head.appendChild(style);
        const viewer = document.createElement('div');
        viewer.id = 'jrsyImageViewer';
        viewer.innerHTML = `<div class="jrsy-viewer-actions"><button class="jrsy-viewer-btn" type="button" data-action="close">关闭</button><button class="jrsy-viewer-btn" type="button" data-action="save">保存图片</button></div><img alt="图片原图预览">`;
        document.body.appendChild(viewer);
        const image = viewer.querySelector('img');
        viewer.querySelector('[data-action="close"]').addEventListener('click', closeImageViewer);
        viewer.querySelector('[data-action="save"]').addEventListener('click', () => void saveViewedImage());
        viewer.addEventListener('click', event => { if (event.target === viewer) closeImageViewer(); });
        viewer.addEventListener('touchstart', event => {
            if (event.touches.length === 2) {
                startDistance = Math.hypot(event.touches[0].clientX-event.touches[1].clientX,event.touches[0].clientY-event.touches[1].clientY);
                startScale = scale;
            }
        }, { passive: true });
        viewer.addEventListener('touchmove', event => {
            if (event.touches.length !== 2 || !startDistance) return;
            const distance = Math.hypot(event.touches[0].clientX-event.touches[1].clientX,event.touches[0].clientY-event.touches[1].clientY);
            scale = Math.min(5, Math.max(1, startScale * distance / startDistance));
            image.style.transform = `scale(${scale})`;
            event.preventDefault();
        }, { passive: false });
        viewer.addEventListener('dblclick', () => {
            scale = scale > 1 ? 1 : 2;
            image.style.transform = `scale(${scale})`;
        });
    }

    function viewImage(source) {
        if (!source) return;
        ensureViewer();
        currentSource = source;
        scale = 1;
        const viewer = document.getElementById('jrsyImageViewer');
        const image = viewer.querySelector('img');
        image.src = source;
        image.style.transform = 'scale(1)';
        viewer.classList.add('open');
    }

    function closeImageViewer() {
        document.getElementById('jrsyImageViewer')?.classList.remove('open');
    }

    async function saveViewedImage() {
        if (!currentSource) return;
        try {
            let href = currentSource;
            let revoke = false;
            if (!/^data:/i.test(currentSource) && !/^blob:/i.test(currentSource)) {
                const response = await fetch(currentSource);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                href = URL.createObjectURL(await response.blob());
                revoke = true;
            }
            const link = document.createElement('a');
            link.href = href;
            link.download = `jrsy-image-${Date.now()}.jpg`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (revoke) setTimeout(() => URL.revokeObjectURL(href), 1000);
            if (typeof showToast === 'function') showToast('图片已保存');
        } catch (error) {
            if (typeof showAlert === 'function') showAlert(`图片保存失败：${error.message}`);
        }
    }

    window.viewImage = viewImage;
    window.closeImageViewer = closeImageViewer;
    window.saveViewedImage = saveViewedImage;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureViewer);
    else ensureViewer();
}());
