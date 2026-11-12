# Rewordly – platform test listesi (yazarken kontrol)

Her maddede önce **ne yapılacağı**, `→` sonrasında **beklenen sonuç** var. Test ederken `[ ]` kutusunu `[x]` yap; sorun çıkarsa maddenin altına not düş.

Test metni önerisi (aynı metin cache'ten geleceği için ikinci denemeden sonra ücretsizdir):

```
I dont know teh answer. She go to school everyday.
Bugün hava çok guzel, yarın görüşmek istiyorm.
```

Sorun bulduğunda bana şunları gönder: sitenin adı ve alan (ör. "LinkedIn → post modalı"), sayfanın Console'undaki `[Rewordly live]` satırları ve alanın HTML'i (sağ tık → Inspect → Copy outerHTML).

**Bir alanı kontrol edip etmediğini anlamak için:** Console'da `attached to field` görünüyorsa alan kontrol ediliyor. `skipping field: <sebep>` görünüyorsa atlanıyor.

---

## 1. Genel testler (her platformda kısaca tekrarla)

### 1.1 Hangi alanlar kontrol ediliyor
- [ ] Arama kutusuna hatalı metin yaz → çizgi yok, Console'da `skipping field: search field (...)`
- [ ] Filtre / etiket / konu (tag, topic) ekleme alanları → çizgi yok
- [ ] Kişi seçme alanları ("To", "@mention" kutuları, alıcı seçici) → çizgi yok
- [ ] Şifre, e-posta, telefon, kart numarası alanları → çizgi yok
- [ ] Kod blokları ve kod editörleri → çizgi yok
- [ ] Normal yazı alanları (yorum, gönderi, mesaj) → çizgi var

### 1.2 Kopyala – yapıştır
- [ ] Hatalı bir paragrafı yapıştır → cümleler birkaç saniye içinde altı çizili
- [ ] Biçimli metin (kalın, link, liste) yapıştır → çizgiler doğru kelimelerin altında, biçim bozulmuyor
- [ ] Çok uzun metin (birkaç sayfa) yapıştır → sayfa donmuyor; önce imlecin çevresi kontrol ediliyor, aşağı kaydırıp tıklayınca orası da kontrol ediliyor
- [ ] Çizgili bir kelimeyi kopyalayıp başka yere yapıştır → yeni yerde de doğru işaretleniyor

### 1.3 Alanlar arası geçiş
- [ ] A alanına yaz, B alanına geç → A'daki çizgiler yerinde kalıyor, B kontrol ediliyor
- [ ] A'ya geri dön ve bir hatayı düzelt → doğru alanda, doğru kelime değişiyor
- [ ] Sayfada önceden dolu bir alana tıkla (ör. taslak) → içindeki metin kontrol ediliyor
- [ ] Mesajı gönder (alan boşalıyor) → çizgiler hemen kayboluyor, eski yerinde çizgi kalmıyor
- [ ] Sayfa içinde başka sayfaya geçiş (SPA navigasyonu) → eski alanın çizgileri ekranda asılı kalmıyor

### 1.4 Çok satırlı metin
- [ ] 3+ satır yaz, imleç sondayken üstteki bir satırdaki hatayı düzelt → sadece o kelime değişiyor, imlecin yeri değişmiyor
- [ ] Ortadaki bir satıra yeni kelime ekle → alttaki çizgiler metinle birlikte kayıyor, titreme yok
- [ ] Bir satırı Enter ile ikiye böl / Backspace ile birleştir → çizgiler doğru kelimelerde kalıyor
- [ ] "Fix all" ile farklı satırlardaki hataları düzelt → metnin geri kalanı değişmiyor
- [ ] Düzeltmeden sonra yazmaya devam et → düzeltme geri dönmüyor (editör eski metni geri getirmiyor)
- [ ] Düzeltmeden sonra Cmd/Ctrl+Z → eski haline dönüyor

### 1.5 Konumlandırma
- [ ] Çizgiler kelimenin tam altında (kayma yok, satır yüksekliği farklı alanlarda da)
- [ ] Sayfayı kaydır → çizgiler kelimelerle birlikte hareket ediyor
- [ ] Alanın kendi içini kaydır → görünmeyen satırların çizgisi gizleniyor
- [ ] Modal içindeki alan (ör. gönderi oluşturma penceresi) → çizgiler modalın içinde, kartlar doğru yerde
- [ ] Üstüne açılır menü / emoji seçici / dropdown gelince → çizgiler o menünün üstünde görünmüyor
- [ ] Yapışkan (sticky) üst bar alanın üstüne gelince → çizgiler barın üstünden görünmüyor
- [ ] Tarayıcı zoom'u %80 ve %125 → çizgiler hâlâ hizalı
- [ ] Pencereyi daralt / genişlet → çizgiler yeniden hizalanıyor
- [ ] Rozet (spinner / hata sayısı / ✓) yazının üstüne binmiyor: sağ alt köşede yazı varsa alanın dışına (sağ), sonra sağ üste, sonra alanın altına geçiyor; sitenin butonlarını kapatmıyor
- [ ] Uzun mesajla kendi içinde kayan alan (Slack, yorum kutuları): içinde kaydırınca çizgiler kısa süre saklanıp durunca yumuşakça geri geliyor; kelimelerin üstünde kayıp oynamıyor
- [ ] Notion'da uzun bir sayfada yazıp sayfayı kaydırınca sayfa takılmıyor, bilgisayar yavaşlamıyor; Console'da `[Rewordly live]` satırları akıp durmuyor (en fazla birkaç satır)
- [ ] Kod blokları (Slack'te ``` ile, Notion'da /code) → altı çizilmiyor, çevresindeki yazı çizilmeye devam ediyor
- [ ] Alanla ilgisi olmayan bir yer kaydırılınca (mesaj listesi, akış) çizgiler etkilenmiyor, sayfa takılmıyor
- [ ] Rozet bir yere geçtikten sonra yazı kısalsa bile yerinde kalıyor (sürekli zıplamıyor)
- [ ] Hiçbir yer boş değilse rozet hiç görünmüyor, ama çizgiler ve kart çalışıyor
- [ ] ✓ yaklaşık 2,5 saniye sonra kayboluyor; hata sayısı, spinner ve limit işareti kalıyor
- [ ] Ekranın alt veya sağ kenarına yakın bir kelimede kart ekran dışına taşmıyor
- [ ] Sitenin karanlık modunda kart ve rozet okunaklı

### 1.6 Diller
- [ ] İngilizce, Türkçe, Almanca, İspanyolca birer cümle → her biri kendi dilinde kontrol ediliyor
- [ ] Aynı alanda karışık dil → her cümle doğru dilde
- [ ] Açıklama metinleri cümlenin dilinde (Türkçe cümle → Türkçe açıklama)
- [ ] Türkçe karakter hataları (icin, guzel, gönderecegim) → yakalanıyor mu? (bilinen zayıf nokta; sonuçları not al)
- [ ] Arapça / İbranice (sağdan sola) → çizgiler doğru kelimelerde
- [ ] Japonca / Çince (boşluksuz) → çizgi kelimenin ortasından başlamıyor
- [ ] Emoji ve özel karakter içeren cümle → çizgiler kaymıyor

### 1.7 Kart ve rozet
- [ ] Çizginin üzerine gel → kart hemen açılıyor; başka çizgiye geçince kart değişiyor
- [ ] Karttan çık → kart kapanıyor; fareyi karta götürünce açık kalıyor
- [ ] Ignore → o çizgi gidiyor; Add to dictionary → kelime bir daha işaretlenmiyor (sayfa yenilense bile)
- [ ] Esc → kart kapanıyor
- [ ] Kartta bir butona tıklamak sitenin modalını / menüsünü kapatmıyor

### 1.8 Ayarlar ve kota
- [ ] Popup → Auto grammar check kapalı → tüm sekmelerde çizgiler kayboluyor
- [ ] Sağ tık → Disable Rewordly on this page → o sitede çizgi yok
- [ ] Deneme hakkı azalınca rozette mor nokta, kartta tek satırlık not
- [ ] Hak bitince gri duraklatma ikonu, limit kartı günde bir kez kendiliğinden açılıyor
- [ ] Sunucu kapalıyken (web'i durdur) → rozet hata gösteriyor, Console sürekli hata basmıyor, sayfa yavaşlamıyor
- [ ] Eklentiyi ↻ ile yeniden yükle, sekmeyi yenilemeden yazmaya devam et → sayfada hata yok

### 1.9 Diğer
- [ ] Seçip Rewrite / Check Grammar → modal açılıyor, açıkken çizgiler görünmüyor
- [ ] Hızlı yaz (kontrol sürerken yazmaya devam et) → yanlış yere çizgi gelmiyor
- [ ] Kart açıkken çizgili kelimeyi değiştir → kart kapanıyor, eski öneri uygulanamıyor
- [ ] Grammarly de kuruluyken → iki eklenti birbirini bozmuyor (en azından sayfa çalışıyor)

---

## 2. Platformlar

### X (Twitter)
Editör: **Draft.js** (imleç yerini kendi modelinde tutuyor; en riskli platform).
- [ ] Arama kutusu (sol menü → Explore, üstteki "Search") → çizgi yok
- [ ] Ana sayfadaki "What's happening?" kutusu → çizgi var, düzeltme sadece o kelimeyi değiştiriyor
- [ ] "Post" butonuyla açılan modal kutu → konum ve düzeltme doğru
- [ ] Yanıt (reply) kutusu → hem tweet altındaki satır içi kutuda hem modalda
- [ ] Thread (+ ile ikinci gönderi kutusu) → her kutu ayrı kontrol ediliyor; bir kutudaki düzeltme diğerine dokunmuyor
- [ ] Alıntı (Quote) gönderi → kutu çalışıyor
- [ ] Karakter sayacı → düzeltmeden sonra sayaç güncelleniyor, Post butonu doğru aktif/pasif
- [ ] @mention ve #hashtag yazarken açılan öneri listesi → çizgiler listenin üstünden görünmüyor; @kullanıcıadı ve #etiket hata sayılmıyor
- [ ] Link içeren gönderi → URL işaretlenmiyor
- [ ] Emoji ekle, sonra öncesindeki bir kelimeyi düzelt → emoji bozulmuyor
- [ ] Çok satırlı gönderi, imleç sonda, üst satırdaki hatayı düzelt → sadece o kelime (önceki hatanın tekrarı yok)
- [ ] DM (mesajlar) kutusu → çalışıyor; mesaj gönderince çizgiler kayboluyor
- [ ] Gönderi taslağını kaydet, tekrar aç → önceki metin kontrol ediliyor

### LinkedIn
Editör: gönderi ve yorumlarda **Quill tabanlı** editör (`ql-editor`), mesajlarda contenteditable.
- [ ] Üstteki arama kutusu → çizgi yok
- [ ] "Start a post" modalı → çizgiler modal içinde; modal kaydırılınca birlikte hareket ediyor
- [ ] Gönderi yorumu ve yoruma yanıt → çalışıyor
- [ ] Mesajlaşma: sağ alttaki küçük pencere ve tam sayfa mesajlar → ikisi de çalışıyor; pencere kapanıp açılınca çizgi asılı kalmıyor
- [ ] @mention (kişi/şirket) eklenmiş metin → mention bozulmuyor, işaretlenmiyor
- [ ] #hashtag → işaretlenmiyor
- [ ] Profil → About / deneyim açıklaması (modal içinde textarea) → çalışıyor
- [ ] Makale / newsletter editörü (Write article) → başlık ve gövde çalışıyor
- [ ] "Rewrite with AI" gibi LinkedIn'in kendi araçları açıkken → çakışma yok
- [ ] İş başvurusundaki açık uçlu sorular (textarea) → çalışıyor; ad, e-posta, telefon alanları atlanıyor

### Gmail
Editör: contenteditable gövde. **Daha önce çalışmadığını söylemiştin, ilk bunu dene.**
- [ ] Üstteki "Search mail" kutusu → çizgi yok
- [ ] To / Cc / Bcc alıcı alanları → çizgi yok
- [ ] Konu (Subject) satırı → kontrol ediliyor mu? (tek satırlık input; çalışmalı)
- [ ] Yeni e-posta (Compose) gövdesi → çizgi var, düzeltme çalışıyor
- [ ] Pop-out (ayrı pencerede) compose → çalışıyor
- [ ] Aynı anda iki compose penceresi → her biri ayrı; birinin düzeltmesi diğerine geçmiyor
- [ ] Yanıt (Reply) → sadece senin yazdığın kısım kontrol ediliyor; alıntılanan eski mesaj ("…" altındaki kısım) işaretlenmiyor
- [ ] İmza → işaretlenmiyor
- [ ] **Smart Compose** (yazarken çıkan gri öneri metni) → gri metin kontrol edilmiyor, Tab ile kabul edince çizgiler kaymıyor
- [ ] Biçimlendirme: kalın kelime içindeki hata, link içindeki hata, madde işaretli liste → düzeltme biçimi bozmuyor
- [ ] Taslağı kapat, Drafts'tan aç → metin kontrol ediliyor
- [ ] Gmail içindeki Google Chat (yan panel) → çalışıyor mu? (iframe içinde)

### Reddit
Editör: yeni Reddit'te zengin metin editörü, **shadow DOM** içinde web bileşenleri; Markdown modu ayrıca bir textarea.
- [ ] Üstteki arama kutusu → çizgi yok
- [ ] Gönderi altındaki yorum kutusu → çalışıyor (shadow DOM içinde konum doğru)
- [ ] Yoruma yanıt (iç içe yorum) → çalışıyor
- [ ] Yeni gönderi: başlık (tek satır) ve gövde → ikisi de çalışıyor
- [ ] Editörü Markdown moduna çevir → textarea'da da çalışıyor; `**kalın**` gibi işaretler hata sayılmıyor
- [ ] Bir yorumu düzenle (Edit) → mevcut metin kontrol ediliyor
- [ ] Flair / etiket seçici → çizgi yok
- [ ] Reddit sohbet (chat) → çalışıyor
- [ ] old.reddit.com → yorum textarea'sı çalışıyor
- [ ] Sonsuz kaydırma ile çok sayıda yorum kutusu açılınca → eski kutuların çizgileri asılı kalmıyor

### Medium
Editör: **Slate** (yanıtlar), özel hikâye editörü.
- [ ] Arama kutusu → çizgi yok
- [ ] Yanıt (Response) kutusu → çizgi var; düzeltme yazmaya devam edince geri dönmüyor
- [ ] Yeni hikâye (Write): başlık, alt başlık, gövde → çalışıyor
- [ ] Gövdede başlık (H2), alıntı, liste → çalışıyor
- [ ] Kod bloğu → işaretlenmiyor
- [ ] Yayınlarken konu (topic) ekleme → çizgi yok
- [ ] Spinner, ✓ ve hata sayısı rozeti doğru köşede; uzun hikâyede rozet ekranın altında kaybolmuyor
- [ ] Düzeltme (update) kütüphane yüzünden eklenememe durumu oluyor mu → yazmaya devam edip, sayfayı yenileyip metnin kaydedildiğini kontrol et
- [ ] Çok satırlı metinde aradaki bir kelimeyi değiştirince → çizgiler kayıyor, yanlış kelime değişmiyor
- [ ] Metni seçince Medium'un kendi araç çubuğu (kalın / link / private note) → kartla çakışmıyor
- [ ] Highlight → Private note kutusu → çalışıyor

### Facebook
Editör: **Lexical** (Meta'nın kendi editörü).
- [ ] Üstteki arama → çizgi yok
- [ ] "What's on your mind?" gönderi modalı → çalışıyor; arka plan renkli gönderi (büyük yazı) modunda konum doğru
- [ ] Yorum ve yoruma yanıt → çalışıyor; Enter ile gönderince çizgiler kayboluyor
- [ ] Messenger (sağ alttaki sohbet pencereleri) → çalışıyor; pencere küçültülünce çizgi asılı kalmıyor
- [ ] Kişi etiketleme (@) → etiket bozulmuyor
- [ ] Emoji / GIF / sticker seçici açılınca → çizgiler seçicinin üstünden görünmüyor
- [ ] Gruplarda gönderi ve Marketplace ilan açıklaması → çalışıyor
- [ ] Haber akışında kaydırma (çok sayıda yorum kutusu) → sayfa yavaşlamıyor

### Instagram (web)
Editör: yorumlarda textarea, gönderi açıklamasında ve DM'de Lexical tabanlı editör.
- [ ] Arama paneli → çizgi yok
- [ ] Gönderi altındaki yorum kutusu ("Add a comment…") → çalışıyor
- [ ] Yeni gönderi → açıklama (caption) alanı modal içinde → çalışıyor
- [ ] DM → çalışıyor; gönderince çizgiler kayboluyor
- [ ] Profil düzenle → Bio → çalışıyor
- [ ] @mention ve #hashtag yoğun metin → işaretlenmiyor
- [ ] Reels / gönderi görüntüleme modalında yorum → konum doğru

### TikTok (web)
Editör: yorumlarda zengin metin editörü (Draft.js benzeri). X'teki imleç sorununun benzeri burada da çıkabilir.
- [ ] Arama kutusu → çizgi yok
- [ ] Video altındaki yorum kutusu → çalışıyor; üst satırdaki hatayı düzeltince imlecin yeri değişmiyor
- [ ] @mention ve #hashtag (renkli token olarak görünüyor) → bozulmuyor, işaretlenmiyor
- [ ] DM → çalışıyor
- [ ] TikTok Studio → video yükleme → açıklama (caption) → çalışıyor
- [ ] Video tam ekran / yan panel açıkken → çizgiler doğru yerde

### Notion
Editör: Notion'a özel; **her blok ayrı bir düzenlenebilir alan**.
- [ ] Sol menüdeki Search ve Cmd+K arama → çizgi yok
- [ ] Sayfa başlığı → çalışıyor
- [ ] Normal paragraf blokları → çalışıyor
- [ ] Bloklar arası geçiş: 10+ blokluk sayfada yukarıdaki bloklara geri dön → önceki blokların çizgileri duruyor mu? (aynı anda 6 alanın çizgisi tutuluyor; daha eski bloklarda kaybolması beklenen bir sınır, not al)
- [ ] "/" komut menüsü açıkken → çizgiler menünün üstünden görünmüyor
- [ ] Başlık, toggle, yapılacaklar listesi, alıntı blokları → çalışıyor
- [ ] Kod bloğu → işaretlenmiyor
- [ ] Satır içi mention (@kişi, @tarih) ve satır içi kod → bozulmuyor
- [ ] Veritabanı tablosu hücresi, kartlı (board) görünümde kart başlığı → çalışıyor mu, konum doğru mu
- [ ] Yorumlar → çalışıyor
- [ ] Blok sürükle-bırak sonrası → çizgiler yeni yerde
- [ ] Düzeltmeden sonra sayfayı yenile → düzeltme kaydedilmiş

### Trello
Editör: kart açıklaması ve yorumlarda **Atlassian editörü (ProseMirror tabanlı)**.
- [ ] Arama → çizgi yok
- [ ] Yeni kart ekleme kutusu (liste altındaki "Add a card") → çalışıyor
- [ ] Kart başlığı düzenleme → çalışıyor
- [ ] Kart açıklaması (Description) → çalışıyor; Markdown / biçimli içerik bozulmuyor
- [ ] Yorum → çalışıyor; Save sonrası kaydedilen metin düzeltilmiş hali
- [ ] Kontrol listesi (checklist) maddesi → çalışıyor
- [ ] Kart modalı kaydırılınca → çizgiler birlikte hareket ediyor
- [ ] Etiket ve üye seçici → çizgi yok

### Jira
Editör: açıklama ve yorumlarda **Atlassian editörü (ProseMirror)**; özet alanı satır içi düzenleme.
- [ ] Üst arama ve **JQL** arama kutusu → çizgi yok (JQL kod gibidir, işaretlenmemeli)
- [ ] Create issue modalı → Summary ve Description → çalışıyor
- [ ] Issue özetini (Summary) satır içi düzenle → düzenleme moduna geçince çalışıyor; kaydedince çizgi asılı kalmıyor
- [ ] Description → çalışıyor; tablo, panel, kod bloğu ve makrolar bozulmuyor; kod bloğu işaretlenmiyor
- [ ] Yorum ("Add a comment") → çalışıyor
- [ ] @mention ve issue linkleri (ABC-123) → işaretlenmiyor
- [ ] Assignee / label / component seçicileri → çizgi yok
- [ ] Sağ panel (issue detay görünümü) ve tam sayfa görünüm → ikisinde de konum doğru

---

## 3. Listeye eklemeni önerdiğim platformlar

Kullanıcıların en çok yazdığı yerler ve bizim için riskli olanlar:

### Slack (web)
- [ ] Mesaj kutusu → çalışıyor; Enter ile gönderince çizgiler kayboluyor
- [ ] Thread yanıtı (sağ panel) → çalışıyor
- [ ] Üstteki arama → çizgi yok
- [ ] `kod` ve ```kod bloğu``` → işaretlenmiyor
- [ ] @mention, #kanal, emoji kodları (:smile:) → işaretlenmiyor

### WhatsApp Web
- [ ] Mesaj kutusu → çalışıyor; kısa sohbet mesajlarında gereksiz uyarı yok
- [ ] Arama ve "Search or start a new chat" → çizgi yok

### Discord
- [ ] Mesaj kutusu (Slate tabanlı) → çalışıyor; düzeltme yazmaya devam edince geri dönmüyor
- [ ] Emoji, @mention, kanal linkleri → bozulmuyor

### Outlook (web)
- [ ] E-posta gövdesi → çalışıyor; yanıtta alıntılanan eski mesaj işaretlenmiyor
- [ ] Alıcı alanları ve arama → çizgi yok

### ChatGPT / Claude (prompt kutuları)
Kullanıcılar buralarda çok yazıyor ve İngilizceyi ikinci dil olarak kullananlar için önemli.
- [ ] Prompt kutusu → çalışıyor; uzun prompt yapıştırınca sayfa donmuyor
- [ ] Prompt içindeki kod → işaretlenmiyor

### GitHub
- [ ] Issue / PR yorumu (textarea, Markdown) → çalışıyor; Markdown işaretleri ve kod hata sayılmıyor
- [ ] Kod incelemesi satır yorumu → çalışıyor
- [ ] Kod editörü ve dosya düzenleme → işaretlenmiyor
- [ ] Üstteki arama → çizgi yok

### YouTube
- [ ] Video yorumu → çalışıyor
- [ ] Arama kutusu → çizgi yok

### Google Docs (desteklenmiyor; olumsuz test)
- [ ] Doküman açıkken → çizgi, rozet ve hata çıkmıyor; sayfa yavaşlamıyor
