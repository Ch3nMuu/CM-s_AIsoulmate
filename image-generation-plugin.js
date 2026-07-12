(function () {
    'use strict';

    const DEFAULT_IMAGE_API_SETTINGS = Object.freeze({ enabled:false, apiUrl:'', apiKey:'', endpoint:'/v1/images/generations', authType:'bearer', customAuthHeader:'', customAuthPrefix:'', modelName:'', size:'1024x1536', quality:'medium', outputFormat:'jpeg', sendQuality:true, sendOutputFormat:false, sendN:true, timeout:120000, extraHeadersJson:'', extraBodyJson:'', responseType:'auto', presets:[] });
    const REFERENCE_IDENTITY_PROMPT = `【V001固定身份一致性约束】

参考图片中的人物是同一个固定角色 V001。

三张参考图具有不同作用：

第一张（face_identity_front）：
作为最高优先级身份基准，用于锁定脸部身份、五官结构和人物识别。

第二张（face_multiview）：
用于补充不同角度下的脸型、侧脸轮廓、头部比例、发型和后脑结构。

第三张（body_reference）：
用于补充身体比例、身材轮廓和整体体态。

请生成同一个 V001 角色，而不是生成相似人物。

必须保持：
- 相同的人物身份
- 相同的脸部结构
- 相同的眼睛、眉形、鼻子、嘴唇
- 相同的发色、发型、长发长度
- 相同的眼镜与特殊装饰
- 相同的性别和年龄感
- 相同的整体气质

禁止：
- 创建新人物
- 改变人物性别
- 根据场景重新设计脸
- 只保留金发、眼镜等表面特征
- 将参考图理解为风格参考

允许改变：
- 场景
- 服装
- 动作
- 摄影角度
- 光线`;
    const IMAGE_TYPES = new Set(['image','photo','picture','selfie','generate_image','send_image']);
    const TEST_REFERENCE_MODE = "face_only";
    const activeRequests = new Map();
    let cachedSettings = null;

    const uid = () => `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function normalizeSettings(value={}) { return {...DEFAULT_IMAGE_API_SETTINGS,...value,presets:Array.isArray(value.presets)?value.presets:[]}; }
    async function getSettings(){ if(cachedSettings)return normalizeSettings(cachedSettings); try{cachedSettings=await dbManager.get('apiSettings','image-settings');}catch(_){cachedSettings=null;} return normalizeSettings(cachedSettings); }
    async function saveSettings(value){ cachedSettings={...normalizeSettings(value),id:'image-settings'}; await dbManager.set('apiSettings',cachedSettings); return cachedSettings; }

    function detectExplicitPhotoRequest(text=''){
        console.log('[DEBUG DETECT INPUT]', text);
        const normalizedText=String(text||'').trim().toLowerCase().replace(/\s+/g,' ');
        const deny=[/描述.{0,8}(你|自己).{0,8}(样子|穿着|外貌)/,/如果.{0,8}(能|可以).{0,8}(看到|看见)你/,/我想你了|你在干嘛|你在哪|你今天穿什么/];
        const allow=[/给我(?:看|看看|看一看).{0,12}你/,/(?:给我)?发(?:一|1)?张?.{0,8}(照片|图片|自拍|相片)/,/(?:拍|照)(?:一|1)?张?.{0,8}(照片|图片|自拍|相片)?(?:给我|发我|看看)?/,/^(?:来|发|拍)?(?:一|1)?张?自拍(?:照|照片)?(?:给我|发我|看看)?[吧呀啊。！!？?]*$/,/(?:给我|让我|想)看看你.{0,16}(样子|穿着|衣服|现在|在干嘛)?/,/(?:给我|让我).{0,8}(?:看|看看|看一看).{0,12}(?:照片|图片|自拍|相片)/,/(?:给我|帮我)?(?:生成|制作)(?:一|1)?张?.{0,16}(?:照片|图片|自拍|相片)/,/show me (?:a |your )?(?:photo|picture|selfie)/,/send me (?:a |your )?(?:photo|picture|selfie)/,/take (?:a |your )?(?:photo|picture|selfie)/];
        const matched=allow.find(p=>p.test(normalizedText)); const denied=!matched&&deny.some(p=>p.test(normalizedText));
        const result={requested:Boolean(matched),confidence:matched?'high':'none',matchedRule:matched?matched.toString():(denied?'deny-pattern':null),normalizedText};
        console.log('[DEBUG DETECT RESULT]', result);
        return result;
    }
    function createTurnContext(messages=[]){console.log('[DEBUG TURN CONTEXT INPUT]', messages);const latestUserText=messages.map(m=>typeof m==='string'?m:(m?.contentType==='text'?m.content||'':'')).filter(Boolean).join('\n');const photoRequest=detectExplicitPhotoRequest(latestUserText);console.log('[DEBUG PHOTO REQUEST]', {text:latestUserText,requested:photoRequest.requested,matchedRule:photoRequest.matchedRule});const context={id:uid(),friendId:null,createdAt:new Date().toISOString(),latestUserText,photoRequest,realImageGenerationAllowed:photoRequest.requested,realImageGenerationConsumed:false};console.log('[JRSY Image Trigger] turn context',{latestUserText,requested:photoRequest.requested,matchedRule:photoRequest.matchedRule});return context;}
    function sanitizeImageActions(actions,ctx){
        console.log('[DEBUG SANITIZE INPUT]', actions);
        if(!Array.isArray(actions))return actions;
        const sanitized=actions.reduce((out,source)=>{
            if(!source||typeof source!=='object')return out;
            const action={...source},type=String(action.type||'').toLowerCase();
            if(!IMAGE_TYPES.has(type)){out.push(action);return out;}
            const prompt=[action.image_prompt,action.prompt,action.description,action.imageDescription,action.scene,action.content].find(v=>typeof v==='string'&&v.trim());
            if(!prompt)return out;
            action.type='image';
            action.image_prompt=prompt.trim();
            const generate=ctx?.realImageGenerationAllowed===true&&ctx?.realImageGenerationConsumed!==true;
            if(generate){action.imageMode='generate';ctx.realImageGenerationConsumed=true;}
            else action.imageMode='prompt-only';
            console.log('[JRSY Image Trigger] image action',{imageMode:action.imageMode,allowed:ctx?.realImageGenerationAllowed===true,consumed:ctx?.realImageGenerationConsumed===true});
            out.push(action);
            return out;
        },[]);
        if(ctx?.realImageGenerationAllowed===true&&ctx?.realImageGenerationConsumed!==true){
            const prompt=String(ctx.latestUserText||'').trim();
            if(prompt){
                const action={type:'image',imageMode:'generate',image_prompt:prompt};
                ctx.realImageGenerationConsumed=true;
                sanitized.push(action);
                console.log('[JRSY Image Action Created]',{imageMode:action.imageMode,friendId:ctx.friendId,turnContextId:ctx.id});
            }
        }
        console.log('[DEBUG SANITIZE OUTPUT]', sanitized);
        return sanitized;
    }

    function joinApiUrl(base,endpoint){const b=String(base||'').trim().replace(/\/+$/,'');let e=String(endpoint||'').trim();if(!b)throw new Error('请填写生图 API 地址');if(/^https?:\/\//i.test(e))return e;if(/\/v1$/i.test(b)&&/^\/v1(?:\/|$)/i.test(e))e=e.replace(/^\/v1/i,'');return b+(e.startsWith('/')?e:`/${e}`);}
    function parseJson(text,label){if(!String(text||'').trim())return{};try{return JSON.parse(text);}catch(_){throw new Error(`${label} JSON 格式错误`);}}
    function buildHeaders(s){const h={'Content-Type':'application/json',...parseJson(s.extraHeadersJson,'额外请求头')};if(s.authType==='bearer'&&s.apiKey)h.Authorization=`Bearer ${s.apiKey}`;else if(s.authType==='x-api-key'&&s.apiKey)h['x-api-key']=s.apiKey;else if(s.authType==='custom'){if(!s.customAuthHeader)throw new Error('请填写自定义认证 Header');h[s.customAuthHeader]=`${s.customAuthPrefix||''}${s.apiKey||''}`;}return h;}
    function buildBody(s,prompt,overrides={}){if(!s.modelName)throw new Error('请填写生图模型名称');const extra=parseJson(s.extraBodyJson,'额外请求体');const body={...extra,model:s.modelName,prompt,n:1,size:s.size,...overrides};body.prompt=prompt;body.n=1;if(!s.sendQuality)delete body.quality;else body.quality=overrides.quality||s.quality;if(!s.sendOutputFormat)delete body.output_format;else body.output_format=s.outputFormat;return body;}
    function extractGeneratedImage(data){
        const candidates=[data?.data?.[0]?.b64_json,data?.data?.[0]?.base64,data?.data?.[0]?.url,data?.data?.[0]?.image,data?.image,data?.imageUrl,data?.image_url,data?.base64,data?.imageBase64,data?.image_base64,data?.b64_json,data?.output?.[0]?.url,data?.result?.url,data?.result?.image,data?.images?.[0]?.url,data?.images?.[0]];
        let value=candidates.find(v=>typeof v==='string'&&v.trim());
        if(!value&&typeof data==='string'){
            const responseText=data.trim();
            const md=responseText.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/i);
            const url=responseText.match(/https?:\/\/[^\s"'<>]+/i);
            value=md?.[1]||url?.[0]||(/^data:image\/[^;,]+;base64,/i.test(responseText)?responseText:null);
        }
        if(!value)throw new Error('接口返回中没有找到图片');
        value=value.trim();
        if(/^data:image\/[^;,]+;base64,/i.test(value)){
            console.log('[JRSY Image Parse] detected base64');
            console.log('[JRSY Image Parse] image ready');
            return value;
        }
        if(/^https?:\/\//i.test(value)){
            console.log('[JRSY Image Parse] image ready');
            return value;
        }
        console.log('[JRSY Image Parse] detected base64');
        const image=`data:image/png;base64,${value}`;
        console.log('[JRSY Image Parse] image ready');
        return image;
    }
    function normalizeImageApiError(error){if(error?.name==='AbortError')return new Error('生图请求超时');const text=String(error?.message||error||'生图失败').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,240);if(/Failed to fetch|NetworkError/i.test(text))return new Error('无法连接生图接口，请检查地址、网络或 CORS 设置');return new Error(text);}
    function inspectReferenceImages(referenceImages=[]){const items=referenceImages.map((value,index)=>{const match=String(value||'').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);const mimeType=match?.[1]||'unknown';const payload=match?.[2]||'';const isBase64=/;base64,/i.test(String(value||'').slice(0,100));const padding=isBase64?(payload.match(/=*$/)?.[0].length||0):0;const bytes=isBase64?Math.max(0,Math.floor(payload.length*3/4)-padding):new TextEncoder().encode(payload).length;return{index,mimeType,bytes};});return{exists:items.length>0,count:items.length,mimeTypes:items.map(item=>item.mimeType),totalBytes:items.reduce((sum,item)=>sum+item.bytes,0),items};}
    function normalizeReferenceEntries(values=[]){return(Array.isArray(values)?values:[]).map((value,index)=>typeof value==='string'?{key:`reference-${index+1}`,dataUrl:value}:{key:String(value?.key||`reference-${index+1}`),dataUrl:value?.dataUrl}).filter(item=>typeof item.dataUrl==='string'&&item.dataUrl);}
    async function generateImage(prompt,settingsOverride=null,options={}){
        const s=normalizeSettings(settingsOverride||await getSettings());
        if(!s.enabled)throw new Error('生图服务未启用');
        if(!s.apiUrl)throw new Error('生图 API 地址为空');
        if(!s.apiKey&&s.authType!=='none')throw new Error('生图 API Key 为空');
        if(!s.modelName)throw new Error('生图模型名称为空，请在生图 API 设置中确认模型名');

        const url=joinApiUrl(s.apiUrl,s.endpoint);
        const body=buildBody(s,prompt);
        const loadedReferenceImages=Array.isArray(options.referenceImages)
            ? options.referenceImages
            : (options.character&&window.CharacterVisualMemory?.loadReferenceImages
                ? await window.CharacterVisualMemory.loadReferenceImages(options.character)
                : []);
        const referenceEntries=normalizeReferenceEntries(loadedReferenceImages).filter(item=>TEST_REFERENCE_MODE!=="face_only"||/(?:face|identity|multiview|V001_body_reference)/i.test(item.key));
        const referenceImages=referenceEntries.map(item=>item.dataUrl);
        const referencePriority=[
            'V001_face_identity_front',
            'V001_face_multiview',
            'V001_body_reference'
        ];
        const testReferenceImages=referencePriority
            .map(name=>referenceEntries.find(item=>item.key.includes(name)))
            .map(item=>item&&(item.dataUrl||item.image||item.content))
            .filter(Boolean);
        console.log('[TEST FACE FRONT ONLY]', {
            count: testReferenceImages.length
        });
        console.log('[TEST SINGLE REFERENCE]',testReferenceImages.length);
        console.log('[TEST ONLY FACE IDENTITY]', {
            count: testReferenceImages.length,
            keys: testReferenceImages.map((_, i) => i)
        });
        console.log('[TEST FACE ID + MULTIVIEW]', {
            count: testReferenceImages.length,
            references: testReferenceImages.map(item => item.slice(0, 50))
        });
        console.log('[FINAL V001 REFERENCE ORDER]', {
            count: testReferenceImages.length,
            order: testReferenceImages.map(item => item)
        });
        console.log('[REFERENCE FINAL]', {
            count: referenceEntries.length,
            keys: referenceEntries.map(x => x.key)
        });
        console.log('[REFERENCE SEND]', {
            count: referenceImages.length,
            sizes: referenceImages.map(x => x.length)
        });
        console.log('[DEBUG IMAGE REFERENCE ORDER]',{
            referenceCount:referenceEntries.length,
            references:referenceEntries.map((item,index)=>({order:index+1,key:item.key,size:item.dataUrl.length}))
        });
        if(referenceImages.length){
            body.reference_images=testReferenceImages;
            body.prompt=`${REFERENCE_IDENTITY_PROMPT}\n\n${body.prompt}`;
        }
        console.log('[API REFERENCE COUNT]', body.reference_images?.length);
        const timeoutMs=Math.max(120000,Number(s.timeout)||120000);
        const referenceDiagnostics=inspectReferenceImages(referenceImages);
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),timeoutMs);

        console.groupCollapsed('[JRSY Image API] request');
        console.log('URL:',url);
        console.log('model:',body.model);
        console.log('body fields:',Object.keys(body));
        console.log('body:',referenceImages.length?{...body,reference_images:`[${referenceImages.length} image data URLs]`}:body);
        console.log('timeoutMs:',timeoutMs);
        console.log('角色ID:',options.characterId||options.character?.id||'');
        console.log('reference image count:',referenceImages.length);
        console.log('request body keys:',Object.keys(body).join(','));
        console.log('reference_images exists:',referenceDiagnostics.exists);
        console.log('reference_images MIME types:',referenceDiagnostics.mimeTypes);
        console.log('reference_images total bytes:',referenceDiagnostics.totalBytes);
        console.groupEnd();

        try{
            console.log('REAL IMAGE REQUEST DIAGNOSTICS',{url,model:body.model,bodyKeys:Object.keys(body),referenceImages:referenceDiagnostics});
            console.log("FINAL IMAGE PROMPT", body.prompt);
            console.log('[DEBUG IMAGE REFERENCE]', {
                referenceCount: referenceImages?.length || 0,
                hasReferenceField: !!body.reference_images,
                referenceSizes: referenceImages?.map(x => x.length),
                bodyKeys: Object.keys(body)
            });
            console.log('[VECTORENGINE FINAL BODY]', {
                body: {
                    ...body,
                    reference_images: body.reference_images?.map(x => x.slice(0, 30))
                },
                hasReferenceImages: Array.isArray(body.reference_images),
                referenceImageCount: body.reference_images?.length || 0,
                referenceImagePreviews: body.reference_images?.map(x => x.slice(0, 30)) || [],
                promptLength: String(body.prompt || '').length
            });
            console.log('[BEFORE FETCH REFERENCE CHECK]', {
                hasBodyReferenceImages: !!body.reference_images,
                referenceCount: body.reference_images?.length || 0,
                referenceSizes: body.reference_images?.map(x => x.length) || [],
                bodyKeys: Object.keys(body)
            });
            let res=await fetch(url,{method:'POST',headers:buildHeaders(s),body:JSON.stringify(body),signal:controller.signal});
            let text=await res.text();
            let responseHeaders=Object.fromEntries(res.headers?.entries?.()||[]);
            console.groupCollapsed('[JRSY Image API] response');
            console.log('status:',res.status);
            console.log('headers:',responseHeaders);
            console.log('response text:',text);
            console.groupEnd();
            if(!res.ok&&referenceImages.length){
                const fallbackBody=buildBody(s,prompt);
                console.warn('[JRSY Image API] reference image request failed; retrying without reference_images',{status:res.status});
                res=await fetch(url,{method:'POST',headers:buildHeaders(s),body:JSON.stringify(fallbackBody),signal:controller.signal});
                text=await res.text();
                responseHeaders=Object.fromEntries(res.headers?.entries?.()||[]);
                console.groupCollapsed('[JRSY Image API] fallback response');
                console.log('status:',res.status);
                console.log('headers:',responseHeaders);
                console.log('response text:',text);
                console.groupEnd();
            }
            if(!res.ok)throw new Error(`生图接口返回 ${res.status}: ${text.replace(/<[^>]*>/g,' ').slice(0,500)}`);
            let data;try{data=JSON.parse(text);}catch(_){data=text;}
            return extractGeneratedImage(data);
        }catch(e){
            console.error('[JRSY Image API] request failed:',e?.name,e?.message);
            throw normalizeImageApiError(e);
        }finally{clearTimeout(timer);}
    }
    function buildCharacterImagePrompt(friend,scene){const p=friend?.imageProfile||{};return[p.appearancePrompt,scene,p.defaultClothingPrompt,p.photographyPrompt,p.negativePrompt?`Avoid: ${p.negativePrompt}`:''].filter(Boolean).join('\n');}

    async function persist(friendId){await dbManager.set('chatHistories',{friendId,messages:chatHistories[friendId]||[]});}
    function refreshMessage(friendId,message,friend){if(currentChatFriendId!==friendId)return;const old=document.querySelector(`.message[data-message-id="${message.id}"]`);if(old)old.remove();addMessageToDOM(message,friend);const box=document.getElementById('chatMessages');if(box)box.scrollTop=box.scrollHeight;}
    async function createPlaceholderMessage({friendId,friend,action,requestId}){const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="100%" height="100%" rx="18" fill="#eee"/><circle cx="180" cy="90" r="22" fill="none" stroke="#777" stroke-width="4" stroke-dasharray="30 18"><animateTransform attributeName="transform" type="rotate" from="0 180 90" to="360 180 90" dur="1s" repeatCount="indefinite"/></circle><text x="180" y="145" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#555">生图中…</text></svg>`;const m=await saveChatMessage(friendId,'received',`data:image/svg+xml,${encodeURIComponent(svg)}`,'',friend.id,'image');m.requestId=requestId;m.imageMode='generate';m.imageGenerationStatus='generating';m.imageDescription=action.image_prompt;await persist(friendId);refreshMessage(friendId,m,friend);return m;}
    async function replacePlaceholderMessage({friendId,friend,message,image}){message.content=image;message.contentType='image';message.imageGenerationStatus='completed';delete message.imageGenerationError;await persist(friendId);refreshMessage(friendId,message,friend);return message;}
    async function markPlaceholderFailed({friendId,friend,message,error}){const msg=esc(error.message);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="380" height="230"><rect width="100%" height="100%" rx="18" fill="#fff1f0"/><text x="24" y="55" font-family="sans-serif" font-size="19" fill="#b42318">生图失败</text><foreignObject x="24" y="75" width="332" height="95"><div xmlns="http://www.w3.org/1999/xhtml" style="font:14px sans-serif;line-height:1.5;color:#633">${msg}</div></foreignObject><text x="24" y="205" font-family="sans-serif" font-size="15" fill="#6c55a3">点击图片重试</text></svg>`;message.content=`data:image/svg+xml,${encodeURIComponent(svg)}`;message.imageGenerationStatus='failed';message.imageGenerationError=error.message;await persist(friendId);refreshMessage(friendId,message,friend);return message;}
 async function handleImageAction({action,friend,friendId}){
    const settings=await getSettings();
    if(!settings.enabled||!settings.apiUrl||!settings.modelName||(settings.authType!=='none'&&!settings.apiKey)){
        await sendPromptOnlyImageMessage({action,friend,friendId});
        showToast('生图服务未配置，已显示图片描述');
        return;
    }
    const requestId=uid();
    if(activeRequests.has(requestId))return;
    const message=await createPlaceholderMessage({friendId,friend,action,requestId});
    activeRequests.set(requestId,true);
    const prompt=buildCharacterImagePrompt(friend,action.image_prompt);
    try{
        console.log('[JRSY Image API] handleImageAction character binding',{character:friend,characterId:friendId});
        const image=await generateImage(prompt,settings,{character:friend,characterId:friendId});
        await replacePlaceholderMessage({friendId,friend,message,image});
    }catch(error){
        await markPlaceholderFailed({friendId,friend,message,error});
    }finally{
        activeRequests.delete(requestId);
    }
 }
    async function retryImageMessage(friendId,messageId){const message=(chatHistories[friendId]||[]).find(m=>m.id===messageId),friend=friends.find(f=>f.id===friendId);if(!message||!friend||message.imageGenerationStatus!=='failed'||activeRequests.has(message.requestId))return;activeRequests.set(message.requestId,true);message.imageGenerationStatus='generating';await persist(friendId);refreshMessage(friendId,message,friend);generateImage(buildCharacterImagePrompt(friend,message.imageDescription),null,{character:friend,characterId:friendId}).then(image=>replacePlaceholderMessage({friendId,friend,message,image})).catch(error=>markPlaceholderFailed({friendId,friend,message,error})).finally(()=>activeRequests.delete(message.requestId));}
    async function sendPromptOnlyImageMessage({action,friend,friendId,senderId=null}){const description=String(action?.image_prompt||action?.description||'').trim();if(!description)return null;const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240"><rect width="100%" height="100%" rx="18" fill="#f3f0ff"/><text x="24" y="42" font-family="sans-serif" font-size="18" fill="#6c55a3">图片描述</text><foreignObject x="24" y="62" width="372" height="154"><div xmlns="http://www.w3.org/1999/xhtml" style="font:16px sans-serif;line-height:1.6;color:#383344">${esc(description)}</div></foreignObject></svg>`;const m=await saveChatMessage(friendId,'received',`data:image/svg+xml,${encodeURIComponent(svg)}`,'',senderId||friend?.id,'image');m.imageGenerationStatus='prompt-only';m.imageMode='prompt-only';m.imageDescription=description;await persist(friendId);if(currentChatFriendId===friendId)addMessageToDOM(m,friend);return m;}
    function handleImageClick(messageId){for(const [friendId,list] of Object.entries(chatHistories)){const m=list.find(x=>x.id===messageId);if(m?.imageGenerationStatus==='failed'){retryImageMessage(friendId,messageId);return true;}}return false;}

    function formSettings(){const g=id=>document.getElementById(id);return normalizeSettings({enabled:g('imgApiEnabled').checked,apiUrl:g('imgApiUrl').value.trim(),apiKey:g('imgApiKey').value,endpoint:g('imgApiEndpoint').value.trim(),authType:g('imgApiAuth').value,customAuthHeader:g('imgApiCustomHeader').value.trim(),customAuthPrefix:g('imgApiCustomPrefix').value,modelName:g('imgApiModel').value.trim(),size:g('imgApiSize').value.trim(),quality:g('imgApiQuality').value.trim(),outputFormat:g('imgApiFormat').value.trim(),sendQuality:g('imgApiSendQuality').checked,sendOutputFormat:g('imgApiSendFormat').checked,sendN:true,timeout:Number(g('imgApiTimeout').value)*1000||120000,extraHeadersJson:g('imgApiExtraHeaders').value,extraBodyJson:g('imgApiExtraBody').value,presets:cachedSettings?.presets||[]});}
    function fillForm(s){for(const [id,key] of Object.entries({imgApiUrl:'apiUrl',imgApiKey:'apiKey',imgApiEndpoint:'endpoint',imgApiAuth:'authType',imgApiCustomHeader:'customAuthHeader',imgApiCustomPrefix:'customAuthPrefix',imgApiModel:'modelName',imgApiSize:'size',imgApiQuality:'quality',imgApiFormat:'outputFormat',imgApiExtraHeaders:'extraHeadersJson',imgApiExtraBody:'extraBodyJson'})){const el=document.getElementById(id);if(el)el.value=s[key]??'';}document.getElementById('imgApiEnabled').checked=s.enabled;document.getElementById('imgApiSendQuality').checked=s.sendQuality;document.getElementById('imgApiSendFormat').checked=s.sendOutputFormat;document.getElementById('imgApiTimeout').value=Math.round(s.timeout/1000);renderPresets(s);}
    async function openSettings(){setActivePage('imageApiSettingsScreen');fillForm(await getSettings());}
    async function saveForm(){await saveSettings(formSettings());showToast('生图 API 设置已保存');}
    function modelListUrls(apiUrl){const base=String(apiUrl||'').trim().replace(/\/+$/,'');if(!base)return[];const urls=[`${base}/models`];if(/\/v1$/i.test(base))urls.push(`${base.replace(/\/v1$/i,'')}/models`);else urls.push(`${base}/v1/models`);return[...new Set(urls)];}
    async function fetchModels(){const s=formSettings(),urls=modelListUrls(s.apiUrl);if(!urls.length){showAlert('请先填写生图 API 地址；也可以直接手动输入模型名称。');return[];}let lastError=null;for(const url of urls){try{const res=await fetch(url,{headers:buildHeaders(s)});if(!res.ok)throw new Error(`HTTP ${res.status}`);const data=await res.json(),items=data.data||data.models||[];const ids=items.map(x=>typeof x==='string'?x:x?.id).filter(Boolean);if(!ids.length)throw new Error('返回中没有模型列表');document.getElementById('imgApiModelList').innerHTML=ids.map(id=>`<option value="${esc(id)}"></option>`).join('');showToast(`已拉取 ${ids.length} 个模型`);return ids;}catch(error){lastError=error;}}showAlert(`无法拉取模型列表（${lastError?.message||'接口不支持'}）。该功能不是必需的，请直接在“模型名称”中手动输入后继续使用。`);return[];}
    async function testConnection(){const result=document.getElementById('imgApiTestResult');try{if(!confirm('测试会真实生成一张图片，并可能消耗额度，是否继续？'))return null;if(result)result.innerHTML='<div style="padding:12px;color:#777">正在测试生图接口…</div>';const image=await generateImage('A realistic smartphone photo of one red apple on a plain table, no text.',formSettings());if(result)result.innerHTML=`<img src="${esc(image)}" style="max-width:160px;border-radius:12px">`;showToast('生图接口连接成功');return image;}catch(error){const normalized=normalizeImageApiError(error);if(result)result.innerHTML=`<div style="padding:12px;color:#b42318">${esc(normalized.message)}</div>`;showAlert(`生图接口测试失败：${normalized.message}`);return null;}}
    async function diagnoseVectorEngineReferenceFields(friendId=currentChatFriendId){const settings=await getSettings();const friend=friends.find(item=>item.id===friendId);if(!friend)throw new Error('未找到当前聊天角色');if(!settings.apiKey&&settings.authType!=='none')throw new Error('当前生图 API Key 为空');const loadedReferenceImages=window.CharacterVisualMemory?await window.CharacterVisualMemory.loadReferenceImages(friend):[];const referenceImages=normalizeReferenceEntries(loadedReferenceImages).map(item=>item.dataUrl);if(!referenceImages.length)throw new Error('当前角色没有可用参考图');const endpoint='https://api.vectorengine.cn/v1/images/generations';const prompt='根据参考图生成同一个人物';const fields=['reference_images','images','input_images'];const results=[];console.log('[VectorEngine reference field diagnostic]',{characterId:friendId,referenceImages:inspectReferenceImages(referenceImages)});for(const field of fields){const body={model:'gpt-image-2',prompt,[field]:referenceImages};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);try{console.groupCollapsed(`[VectorEngine diagnostic] ${field}`);console.log('URL:',endpoint);console.log('body keys:',Object.keys(body));console.log('reference image count:',referenceImages.length);const response=await fetch(endpoint,{method:'POST',headers:buildHeaders(settings),body:JSON.stringify(body),signal:controller.signal});const text=await response.text();const headers=Object.fromEntries(response.headers?.entries?.()||[]);let parsed;try{parsed=JSON.parse(text);}catch(_){parsed=text;}let generated=false;try{generated=Boolean(extractGeneratedImage(parsed));}catch(_){}console.log('status:',response.status);console.log('headers:',headers);console.log('response text:',text);console.log('generated:',generated);console.groupEnd();results.push({field,status:response.status,headers,response:parsed,generated});}catch(error){console.error(`[VectorEngine diagnostic] ${field} failed:`,error);results.push({field,status:null,error:normalizeImageApiError(error).message,generated:false});}finally{clearTimeout(timer);}}console.table(results.map(({field,status,generated,error})=>({field,status,generated,error:error||''})));return results;}
    function renderPresets(s){const el=document.getElementById('imgApiPreset');el.innerHTML='<option value="">选择预设</option>'+s.presets.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');}
    async function savePreset(){const s=formSettings(),name=prompt('预设名称');if(!name)return;const presets=(s.presets||[]).filter(p=>p.name!==name);presets.push({...s,name,presets:undefined});s.presets=presets;await saveSettings(s);renderPresets(s);showToast('生图预设已保存');}
    async function selectPreset(name){const s=await getSettings(),p=s.presets.find(x=>x.name===name);if(p)fillForm({...s,...p,presets:s.presets});}
    async function clearSettings(){if(!confirm('确定清空生图设置？'))return;await saveSettings(DEFAULT_IMAGE_API_SETTINGS);fillForm(await getSettings());}

    function toggleApiKeyVisibility(){const input=document.getElementById('imgApiKey'),icon=document.getElementById('imgApiKeyEye');if(!input)return;const reveal=input.type==='password';input.type=reveal?'text':'password';if(icon)icon.className=reveal?'ri-eye-off-line':'ri-eye-line';}
    function init(){if(document.getElementById('imageApiSettingsScreen'))return;const apiRow=document.querySelector('#settingsApp .form-group-row[onclick="openApiSettings()"]');apiRow?.insertAdjacentHTML('afterend','<div class="form-group-row clickable" onclick="JrsyImageGeneration.openSettings()"><label class="form-label">生图 API 设置</label><div class="form-value-display"><i class="ri-arrow-right-s-line"></i></div></div>');document.getElementById('apiSettingsScreen')?.insertAdjacentHTML('afterend',`<div id="imageApiSettingsScreen" class="page"><div class="nav-bar"><button class="nav-btn" onclick="backToSettingsMenu()"><i class="ri-arrow-left-s-line"></i></button><div class="nav-title">生图 API 设置</div><div></div></div><div class="settings-content bw-style"><div class="form-card"><div class="form-group-row"><label class="form-label">选择预设</label><select class="form-select" id="imgApiPreset" onchange="JrsyImageGeneration.selectPreset(this.value)"></select></div><div class="form-group-row"><button class="bw-chip-btn" onclick="JrsyImageGeneration.savePreset()">保存当前预设</button></div><div class="form-group-row"><label class="form-label">生图 API 地址</label><input class="form-input" id="imgApiUrl" placeholder="https://..."></div><div class="form-group-row"><label class="form-label">生图 API Key</label><input type="password" class="form-input" id="imgApiKey"><button type="button" class="bw-chip-btn" aria-label="显示或隐藏 API Key" title="显示或隐藏 API Key" onclick="JrsyImageGeneration.toggleApiKeyVisibility()"><i id="imgApiKeyEye" class="ri-eye-line"></i></button></div><div class="form-group-row"><label class="form-label">接口路径</label><input class="form-input" id="imgApiEndpoint"></div><div class="form-group-row"><label class="form-label">认证方式</label><select class="form-select" id="imgApiAuth"><option value="bearer">Bearer Token</option><option value="x-api-key">x-api-key</option><option value="custom">自定义 Header</option><option value="none">无认证</option></select></div></div><div class="form-card"><div class="form-group-row"><label class="form-label">模型名称</label><input class="form-input" id="imgApiModel" list="imgApiModelList" placeholder="可手动输入任意模型名称"><datalist id="imgApiModelList"></datalist></div><div class="form-hint">模型列表仅用于辅助选择；中转站不支持列表接口时，可直接手动输入模型名称。</div><div class="form-group-row"><button class="bw-action-btn solid-outline" onclick="JrsyImageGeneration.fetchModels()">拉取模型列表（可选）</button></div></div><div class="form-card"><div class="form-group-row"><label class="form-label">尺寸</label><input class="form-input" id="imgApiSize" list="imgSizeList"><datalist id="imgSizeList"><option value="1024x1024"><option value="1024x1536"><option value="1536x1024"></datalist></div><div class="form-group-row"><label class="form-label">质量</label><input class="form-input" id="imgApiQuality" list="imgQualityList"><datalist id="imgQualityList"><option value="low"><option value="medium"><option value="high"></datalist></div><div class="form-group-row"><label class="form-label">输出格式</label><input class="form-input" id="imgApiFormat" list="imgFormatList"><datalist id="imgFormatList"><option value="jpeg"><option value="png"><option value="webp"></datalist></div><div class="form-group-row switch-row"><label class="form-label">发送 quality</label><input type="checkbox" id="imgApiSendQuality"></div><div class="form-group-row switch-row"><label class="form-label">发送 output_format</label><input type="checkbox" id="imgApiSendFormat"></div></div><div class="form-card"><div class="form-group-row switch-row"><label class="form-label">启用真实生图</label><input type="checkbox" id="imgApiEnabled"></div><details><summary class="form-group-row">高级设置</summary><div class="form-group-row"><label class="form-label">自定义 Header</label><input class="form-input" id="imgApiCustomHeader"></div><div class="form-group-row"><label class="form-label">认证前缀</label><input class="form-input" id="imgApiCustomPrefix"></div><div class="form-group-row"><label class="form-label">请求超时(秒)</label><input type="number" class="form-input" id="imgApiTimeout"></div><div class="form-group-row"><label class="form-label">额外请求头 JSON</label><textarea class="form-input" id="imgApiExtraHeaders"></textarea></div><div class="form-group-row"><label class="form-label">额外请求体 JSON</label><textarea class="form-input" id="imgApiExtraBody"></textarea></div></details></div><div id="imgApiTestResult" style="text-align:center;margin:12px"></div><div class="settings-buttons"><button class="settings-btn" onclick="JrsyImageGeneration.testConnection()">测试连接</button><button class="settings-btn btn-black" onclick="JrsyImageGeneration.saveForm()">保存全部设置</button><button class="settings-btn" onclick="JrsyImageGeneration.clearSettings()">清空生图设置</button></div></div></div>`);}

    const api={init,getSettings,saveSettings,detectExplicitPhotoRequest,createTurnContext,sanitizeImageActions,joinApiUrl,buildHeaders,buildBody,extractGeneratedImage,normalizeImageApiError,inspectReferenceImages,buildCharacterImagePrompt,generateImage,handleImageAction,sendPromptOnlyImageMessage,createPlaceholderMessage,replacePlaceholderMessage,markPlaceholderFailed,retryImageMessage,handleImageClick,openSettings,saveForm,fetchModels,testConnection,diagnoseVectorEngineReferenceFields,savePreset,selectPreset,clearSettings,toggleApiKeyVisibility,modelListUrls};
    window.JrsyImageGeneration=api;
    window.handleImageAction=handleImageAction;
    window.generateImage=generateImage;
    window.diagnoseVectorEngineReferenceFields=diagnoseVectorEngineReferenceFields;
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
}());
