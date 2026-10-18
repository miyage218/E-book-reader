# Okuyucu — Kindle benzeri PDF kitap okuyucu

Telefonda kullanılmak üzere tasarlanmış, göz yormayan bir PDF okuma uygulaması (HTML / PWA).
Tamamen tarayıcıda çalışır; kitaplarınız hiçbir sunucuya gönderilmez.

## Özellikler
- **Birden fazla PDF ekleme** — “PDF ekle” ile bir veya birden çok dosya seçilir.
- **Kalıcı kitaplık** — PDF'ler ve okuma konumu cihazda (IndexedDB) saklanır; uygulama kapansa da kalır.
- **Kaldığın yerden devam** — her sayfa çevirişte konum otomatik kaydedilir.
- **Ana ekran** — “Okumaya devam et” kartı, her kitap için yüzde, kalan sayfa sayısı ve son okuma zamanı.
- **Kindle görünümü**
  - *Metin* modu: PDF'teki yazı çıkarılıp e-kitap gibi yeniden dizilir (Literata yazı tipi, iki yana yaslı, ayarlanabilir boyut / satır aralığı / kenar boşluğu).
  - *Orijinal sayfa* modu: PDF sayfası olduğu gibi gösterilir (taranmış PDF'ler otomatik bu modda açılır).
  - Temalar: Beyaz, Kağıt, Sepya, Gece.
  - Alt bilgi: okunan yüzde, sayfa, kalan okuma süresi.
- **Gezinme** — sağa/sola dokun veya kaydır; ortaya dokununca menü (içindekiler, sayfa kaydırıcısı, görünüm ayarları).
- **Çevrimdışı** — bir kez açıldıktan sonra internet olmadan çalışır.

## Telefona kurulum
Uygulama bir web sunucusundan (HTTPS) açılmalıdır; `index.html` dosyasını doğrudan açmak çalışmaz.

En kolay yol **GitHub Pages**:
1. GitHub'da depo → **Settings → Pages**.
2. *Source*: “Deploy from a branch”, branch: `master` (veya `main`), klasör: `/ (root)` → **Save**.
3. Birkaç dakika sonra adres hazır olur: `https://<kullanıcı-adı>.github.io/<depo-adı>/`
4. Telefonda bu adresi açın:
   - **iPhone (Safari):** Paylaş → **Ana Ekrana Ekle**
   - **Android (Chrome):** ⋮ menü → **Ana ekrana ekle / Uygulamayı yükle**

Ana ekrandan açıldığında tam ekran, uygulama gibi çalışır.

## Bilgisayarda deneme
```bash
npx http-server .     # veya: python3 -m http.server
```
Ardından `http://localhost:8080` adresini açın.

## Notlar
- Metin modu, PDF'in içindeki yazıyı kullanır; karmaşık sayfa düzenlerinde (tablo, çok sütun, dipnot) bazı satırlar karışabilir — o zaman *Aa → Orijinal sayfa* seçin.
- Veriler tarayıcıya aittir: tarayıcı verilerini silmek kitaplığı da siler.
- PDF işleme: [pdf.js](https://mozilla.github.io/pdf.js/) (Apache 2.0, `lib/` içinde).
