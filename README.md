# EdcWatch — birlikte izle

Netflix Teleparty gibi, ama **herhangi bir sitedeki videoyla** çalışır (Netflix, Prime, korsan siteler, iframe içindeki oynatıcılar…). Biri durdurunca diğerinde de durur, biri sarınca ikisi de aynı yere gider. Cihazlar farklı evlerde, farklı ağlarda olabilir.

```
 Eren'in Safari'si ──┐                     ┌── Doğa'nın iPad Safari'si
   (EdcWatch eklentisi) ──►  Cloudflare Worker (ücretsiz, https)  ◄── (EdcWatch eklentisi)
                          oda durumunu tutar, ikisine de iletir
```

- **Eklenti** (`extension/`): sayfadaki `<video>`'yu bulur (iframe'ler dahil), oynat/durdur/sar/hız olaylarını odaya yollar, odadan gelenleri videoya uygular.
- **Sunucu** (`worker/`): küçük bir Cloudflare Worker. Her oda bir Durable Object. Hem davet sayfasını hem eşleme sunucusunu aynı `https://…workers.dev` adresinden sunar. **Ücretsiz plan yeterli, kredi kartı istemez.**
- Yerelde denemek için aynı mantığı çalıştıran bir Node sunucusu da var (`server/`).

## Kurulum (bir kez)

### 1) Sunucuyu yayınla (ücretsiz)

1. https://dash.cloudflare.com adresinden ücretsiz hesap aç.
2. Mac'te Node.js kur (yoksa): `brew install node` ya da https://nodejs.org
3. Terminalde:
   ```sh
   cd worker
   npm install
   npx wrangler login      # tarayıcı açılır, izin ver
   npx wrangler deploy
   ```
4. Çıktıda `https://edcwatch.<kullanıcı>.workers.dev` benzeri bir adres görürsün. Tarayıcıda aç, “EdcWatch” sayfası gelmeli. Bu adresi not al.

> Netlify bu iş için uygun değil: eşleme için kalıcı WebSocket bağlantısı gerekiyor, Netlify bunu desteklemiyor.

### 2) Safari uygulamasını üret (Mac + iPad)

Safari eklentileri bir uygulamanın içinde gelir. Betik bunu senin için hazırlar:

```sh
./scripts/make-safari-app.sh https://edcwatch.<kullanıcı>.workers.dev
```

Xcode projesi açılır (Xcode'u App Store'dan ücretsiz kur, bir kez aç). Sunucu adresi eklentiye gömülür, iPad'de ayrıca ayar yapman gerekmez.

**Mac için:** Xcode → Settings → Accounts'a Apple ID'ni ekle. Projede hem uygulama hem eklenti hedefleri için *Signing & Capabilities → Team* olarak kendi hesabını (Personal Team) seç. Üstte **EdcWatch (macOS)** ve **My Mac**'i seçip ▶ Run. Sonra Safari → Ayarlar → Uzantılar'da **EdcWatch**'ı aç ve “Tüm web sitelerine izin ver”i seç.

**iPad için:** iPad'i kabloyla Mac'e bağla. iPad'de Ayarlar → Gizlilik ve Güvenlik → *Geliştirici Modu*'nu aç (yeniden başlatır). Xcode'da **EdcWatch (iOS)** ve iPad'i seçip ▶ Run. iPad'de Ayarlar → Genel → VPN ve Aygıt Yönetimi'nden geliştirici profiline güven. Sonra Ayarlar → Apps → Safari → Uzantılar → **EdcWatch**'ı aç ve tüm sitelere izin ver.

> ⚠️ **Ücretsiz Apple ID kısıtı:** Apple, ücretsiz hesapla yüklenen uygulamaları **7 gün** sonra kapatır. iPad'deki uygulamanın süresi dolunca iPad'i Mac'e bağlayıp Xcode'dan tekrar ▶ Run yapman gerekir (kablosuz yenileme ancak aynı ağdayken olur). Farklı evlerdeyseniz bu haftalık bir buluşma/kargo demek. Kalıcı çözüm yıllık 99$'lık Apple Developer hesabı (TestFlight ile 90 gün, uzaktan kurulum). Mac tarafında da süre dolarsa aynı şekilde yeniden Run yeterli.

## Kullanım

**Eren (odayı kuran):** Safari'de filmin/dizinin sayfasını aç → araç çubuğundaki EdcWatch simgesi → adını yaz → **Oda kur ve aç**. Davet linki panoya kopyalanır, Doğa'ya WhatsApp/iMessage ile gönder. (Sayfayı açmadan da olur: linki popup'taki kutuya yapıştır.)

**Doğa:** iPad'de linke dokun → **Katıl ve izle** → site kendi sekmesinde açılır ve odaya bağlanır. Sayfa “▶ Birlikte izlemeye başla” düğmesi gösterirse dokun (Safari, izin almadan videoyu otomatik başlatmayı engeller).

Sonra ikiniz de oynatabilir, durdurabilir, sarabilirsiniz; ekranın üstünde kim ne yaptığını gösteren küçük bir bildirim çıkar.

- **Biri takılırsa** (video yükleniyor): diğerleri bekler, hazır olunca birlikte devam edersiniz.
- **Sonraki bölüme geçince:** diğer tarafa “… başka bir sayfaya geçti — Git” bildirimi gelir.
- **Odadan ayrılmak:** popup → *Odadan ayrıl* (sekmeyi kapatmak da yeter).
- Odada aynı sitenin oynatıcısı bir iframe içindeyse (korsan sitelerde sık) eklenti en büyük videoyu seçer, küçük reklam videolarına dokunmaz.

## Bilinmesi gerekenler

- **Test durumu.** Sunucu ve eşleme mantığı, iki ayrı Chromium profilinde eklentiyle, gerçek `<video>` ile uçtan uca test edildi (davet akışı, oynat/durdur/sar, iframe oynatıcı + reklam, geç katılım, yavaş bağlantı/bekleme, otomatik oynatma engeli, bölüm değişimi, bağlantı kopması, arka plan işçisinin ölüp dirilmesi) hem Node sunucusuna hem Cloudflare Worker'a karşı. **Safari'de ve iPad'de henüz denenmedi**: orada paketleme, izinler ve Safari'ye özgü davranışlar ilk denemede ince ayar isteyebilir.
- **Netflix:** Netflix `video.currentTime` ile sarmayı reddeder; bunun için sayfa içi Netflix API'sini kullanan bir köprü yazıldı (`extension/page-bridge.js`) ama gerçek Netflix hesabıyla **denenmedi**. Ayrıca iPad'deki Netflix *uygulamasını* hiçbir eklenti kontrol edemez; Safari'de Netflix'in web oynatıcısı iPad'de çalışmayabilir. Prime Video ve korsan sitelerde genel yol kullanılır.
- **Tam ekran:** iPad'de Safari'nin yerel tam ekranında bildirimler görünmez, senkron yine çalışır.
- **Gizlilik.** Eklenti tüm sitelerde çalışma izni ister ama oda dışında hiçbir şey yapmaz. Odadayken sunucuya yalnızca oynatma durumu, takma adın ve (aynı site içinde sayfa değişince) sayfa adresi gider. Oynatma durumu kalıcı saklanmaz; odanın sayfa adresi oda boşaldıktan en geç 6 saat sonra silinir. Video içeriği sunucudan geçmez. Davet linkini bilen herkes odaya girebilir (en fazla 8 kişi), linki herkese açık paylaşma.
- **Ücretsiz limitler.** Cloudflare ücretsiz planı günde 100 bin istek verir; iki kişilik izleme bunun çok altında kalır.

## Geliştirme ve test

```sh
npm install && (cd server && npm install) && (cd worker && npm install)

npm run test:server                       # sunucu birim testleri (Node)
npm run test:e2e                          # iki tarayıcı + eklenti + Node sunucusu (ffmpeg ve Chromium gerekir)

# Cloudflare Worker'a karşı aynı testler:
(cd worker && npx wrangler dev --port 8788) &
EDC_TEST_URL=http://127.0.0.1:8788 npm run test:server
EDC_TEST_URL=http://127.0.0.1:8788 npm run test:e2e
```

Eklentiyi Safari olmadan denemek için `extension/` klasörünü Chrome'da *Uzantıları yönet → Paketlenmemiş öğe yükle* ile yükleyebilirsin.

Yapı: `extension/` (Safari/Chrome eklentisi), `shared/room-core.js` (oda mantığı, hem Node hem Worker kullanır), `worker/` (Cloudflare), `server/` (Node sunucusu + davet sayfası), `scripts/` (Safari paketleme), `test/e2e/`.
