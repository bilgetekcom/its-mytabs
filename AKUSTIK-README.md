# Akustik MyTabs

[It's MyTabs](https://github.com/louislam/its-mytabs) 1.7.0 tabanlı kişisel gitar çalışma forkudur. Ana akış: kitaplıktan şarkı bul, gitar kanalını aç, yavaşlat ve istediğin bölümü tekrar çalış.

## Hazırlanan sürüm

- Kitaplık, arama ve içe aktarma ekranının temel metinleri Türkçe.
- Guitar Pro / MusicXML klasörü topluca seçilebilir. Dosyalar sırayla işlenir; ilerleme, başarılı ve başarısız dosyalar ayrı görünür.
- Başarılı dosyalar seçimden çıkarılır. Bozuk dosyalar diğer eserlerin yüklenmesini engellemez.
- Yeni açılan eserlerde gitar kanalı otomatik seçilir. Önceden seçilen kanal hatırlanır.
- Oynatma, hız ayarı, metronom, sayım ve bölüm döngüsü ana projeden gelir.
- Yerel kullanımda hesap, kullanıcı adı ve parola gerekmez; doğrudan kitaplık açılır.

## Windows'ta açma

Hazırlanmış yerel pakette `Baslat.cmd` dosyasını açın. Sunucu arka planda yalnızca `127.0.0.1:47777` adresinde çalışır; tarayıcıda kitaplık açılır. `Durdur.cmd` sunucuyu kapatır. Kişisel kitaplık ve ayarlar `data/` klasöründe saklanır. Yeni kurulumda da hesap oluşturulmaz. Mevcut hesabın kayıtlı ayarları varsa yerel mod bunları kullanmaya devam eder.

Bu fork varsayılan olarak parolasız yerel modda çalışır. Hesaplı sunucu kurulumu için kaynak kodla başlatırken `MYTABS_LOCAL_MODE=false` kullanılabilir. Yerel mod sunucuyu her durumda `127.0.0.1` adresine bağlar.

Kaynak koddan geliştirmek için ana README'deki Deno kurulumu ve `deno task setup` akışını kullanın. Windows paketi için:

```powershell
deno task build-frontend
deno compile --include ./dist --include ./deno.jsonc --include ./extra --include ./backend/separate_worker.ts --allow-all --output akustik-mytabs.exe --node-modules-dir=none --target x86_64-pc-windows-msvc --icon ./frontend/public/favicon.ico ./backend/main.ts
```

## Havuz aktarımı denemesi

8 Ekim 2026'da [AlexMi-Ha/GuitarTabs](https://github.com/AlexMi-Ha/GuitarTabs) koleksiyonundaki 82 dosya alphaTab ile okunup oturum gerektiren yükleme API'sinden içe aktarıldı. Sonuç: **82 eklendi, 0 başarısız**. Aynı koleksiyon ikinci kez verildiğinde SHA-256 karşılaştırmasıyla **82 kopya atlandı**.

Koleksiyon rock/metal ağırlıklıdır. Nothing Else Matters, Hotel California, Boulevard of Broken Dreams ve Wake Me Up When September Ends gibi akustikte çalışılabilecek eserler içerir. Dosyaları açabilmek, her notanın doğruluğunun denetlendiği anlamına gelmez; bazı eski bend efektleri için alphaTab uyumluluk uyarısı verir.

Tekrarlanabilir arşiv aktarımı:

```powershell
node extra/import-pool.mjs 'C:\TabArsivi' 'import-report.json'
```

Bu komut `deno task setup` sonrası, çalışan yerel sunucuya parolasız bağlanır. İç içe klasörleri tarar, desteklenen dosyaları doğrular, mevcut dosya içeriklerini karşılaştırır ve yeni bir JSON sonuç raporu üretir. Önceki raporun üzerine yazmaz. Yalnızca hesaplı modda `MYTABS_EMAIL` ve `MYTABS_PASSWORD` gerekir. CLI aktarımını kitaplık başına bir işlem olarak çalıştırın. Arayüzdeki klasör seçimi dosya başına sonuç verir; arşiv genelinde içerik karşılaştırması CLI aktarımında yapılır.

Yazılım MIT lisansını ve ana proje atıflarını korur. Şarkı dosyaları, kişisel veriler ve giriş bilgileri `data/` altında kalır; Git deposuna dahil edilmez. MP3'ten otomatik tab/akor çıkarma bu sürümün kapsamına dahil edilmemiştir.
