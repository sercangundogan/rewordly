# Helpers Documentation

Bu klasör, `content.ts` dosyasındaki fonksiyonları kategorilere ayırarak oluşturulmuş yardımcı dosyaları içerir.

## Dosya Yapısı

### 📱 UI Helper (`ui-helper.ts`)
**Ne yapar?** Floating button, modal ve tooltip işlemleri

**İçindekiler:**
- `FloatingButtonHelper` - Yüzen buton oluşturma, gösterme, gizleme
- `ModalHelper` - Modal dialog oluşturma, gösterme, gizleme
- `TooltipHelper` - Grammar error tooltip'leri gösterme, gizleme

**Kullanım:**
```typescript
const buttonHelper = new FloatingButtonHelper();
buttonHelper.create();
buttonHelper.show(element, rect);
```

---

### 🔍 Element Helper (`element-helper.ts`)
**Ne yapar?** Editable element bulma, kontrol etme ve yönetme

**İçindekiler:**
- `isEditableElement()` - Element editable mi?
- `extractTextFromElement()` - Element'ten text çıkar
- `isElementVisible()` - Element görünür mü?
- `getElementId()` - Element için benzersiz ID oluştur
- `findAllEditableElements()` - Tüm editable elementleri bul
- `findEditableInElement()` - Element içindeki editable'ları bul
- `shouldIgnoreElement()` - Element ignore edilmeli mi?

**Kullanım:**
```typescript
import { isEditableElement, findAllEditableElements } from './helpers';

const elements = findAllEditableElements();
elements.forEach(el => {
  if (isEditableElement(el)) {
    // ...
  }
});
```

---

### ⚙️ Config Helper (`config-helper.ts`)
**Ne yapar?** Yapılandırma ve platform kontrolü

**İçindekiler:**
- `loadConfig()` - Config yükle
- `isPageDisabled()` - Sayfa disabled mı?
- `isGrammarCheckAllowedSite()` - Grammar check bu sitede aktif mi?
- `createPlatformAdapterForSite()` - Platform adapter oluştur
- `generateErrorId()` - Error ID oluştur

**Kullanım:**
```typescript
import { loadConfig, isGrammarCheckAllowedSite } from './helpers';

const config = await loadConfig();
if (isGrammarCheckAllowedSite()) {
  // ...
}
```

---

### ✅ Grammar Check Helper (`grammar-check-helper.ts`)
**Ne yapar?** Grammar kontrolü ve error yönetimi

**İçindekiler:**
- `checkGrammarAPI()` - Grammar check API çağrısı
- `getDismissKey()` - Dismiss key oluştur
- `isErrorDismissed()` - Error dismissed mı?
- `dismissError()` - Error'ı dismiss et
- `filterDismissedErrors()` - Dismissed error'ları filtrele

**Kullanım:**
```typescript
import { checkGrammarAPI, dismissError } from './helpers';

const response = await checkGrammarAPI(apiUtil, text);
dismissError(elementId, error, text, dismissedErrors);
```

---

### 📝 Text Processing Helper (`text-processing-helper.ts`)
**Ne yapar?** Text extraction, mapping ve position işlemleri

**İçindekiler:**
- `mapInnerTextToTextNodes()` - InnerText pozisyonlarını text node'lara map et
- `extractTextExcludingSignature()` - Signature hariç text çıkar
- `updateErrorPositions()` - Error pozisyonlarını güncelle

**Kullanım:**
```typescript
import { mapInnerTextToTextNodes } from './helpers';

const mapping = mapInnerTextToTextNodes(element, start, end);
if (mapping && mapping.startNode) {
  // ...
}
```

---

### 🎨 Highlight Helper (`highlight-helper.ts`)
**Ne yapar?** Highlight render, update ve clear işlemleri

**İçindekiler:**
- `HighlightContainerHelper` - Highlight container yönetimi
- `getContentEditableErrorRects()` - Contenteditable için rect'ler
- `getInputErrorRects()` - Input/Textarea için rect'ler

**Kullanım:**
```typescript
import { HighlightContainerHelper } from './helpers';

const highlightHelper = new HighlightContainerHelper();
highlightHelper.create();
highlightHelper.renderHighlights(element, errors, getErrorRects);
```

---

## Neden Bu Yapı?

1. **Okunabilirlik**: Her dosya tek bir sorumluluğa sahip
2. **Bakım Kolaylığı**: Değişiklik yapmak için sadece ilgili dosyayı aç
3. **Test Edilebilirlik**: Her helper ayrı ayrı test edilebilir
4. **Yeniden Kullanılabilirlik**: Helper'lar başka yerlerde de kullanılabilir

## Nasıl Kullanılır?

Tüm helper'lar `helpers/index.ts` dosyasından export edilir:

```typescript
import {
  FloatingButtonHelper,
  isEditableElement,
  loadConfig,
  checkGrammarAPI
} from './helpers';
```

Veya spesifik dosyadan:

```typescript
import { isEditableElement } from './helpers/element-helper';
```

