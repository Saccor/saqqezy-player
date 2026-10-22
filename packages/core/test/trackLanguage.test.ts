import { describe, expect, test } from 'vitest';
import { detectTextLanguage, languageFromFileName, languageFromLabel } from '../src/text/trackLanguage.ts';

describe('languageFromLabel', () => {
  test('a bare code, any case, any ISO form', () => {
    expect(languageFromLabel('en')).toBe('en');
    expect(languageFromLabel('SWE')).toBe('sv');
    expect(languageFromLabel('ger')).toBe('de');
    expect(languageFromLabel('pt-BR')).toBe('pt');
    expect(languageFromLabel(' fre ')).toBe('fr');
    expect(languageFromLabel('es-419')).toBe('es');
    expect(languageFromLabel('zh-Hant')).toBe('zh');
  });

  test('undetermined, several or empty: nothing', () => {
    expect(languageFromLabel('und')).toBeUndefined();
    expect(languageFromLabel('mul')).toBeUndefined();
    expect(languageFromLabel('')).toBeUndefined();
    expect(languageFromLabel(undefined)).toBeUndefined();
  });

  test('English names anywhere in the label', () => {
    expect(languageFromLabel('English')).toBe('en');
    expect(languageFromLabel('english (SDH)')).toBe('en');
    expect(languageFromLabel('Track 2 - German')).toBe('de');
    expect(languageFromLabel('Portuguese (Brazil)')).toBe('pt');
  });

  test('native names, with or without accents', () => {
    expect(languageFromLabel('Svenska 5.1')).toBe('sv');
    expect(languageFromLabel('Français')).toBe('fr');
    expect(languageFromLabel('Francais')).toBe('fr');
    expect(languageFromLabel('Español Latino')).toBe('es');
    expect(languageFromLabel('Deutsch DD+')).toBe('de');
    expect(languageFromLabel('Suomi')).toBe('fi');
    expect(languageFromLabel('Norsk')).toBe('no');
    expect(languageFromLabel('Dansk')).toBe('da');
    expect(languageFromLabel('Türkçe')).toBe('tr');
    expect(languageFromLabel('Русский')).toBe('ru');
    expect(languageFromLabel('日本語')).toBe('ja');
    expect(languageFromLabel('한국어')).toBe('ko');
    expect(languageFromLabel('العربية')).toBe('ar');
    expect(languageFromLabel('فارسی')).toBe('fa');
    expect(languageFromLabel('Farsi')).toBe('fa');
  });

  test('bracketed codes', () => {
    expect(languageFromLabel('[EN]')).toBe('en');
    expect(languageFromLabel('Main (swe)')).toBe('sv');
    expect(languageFromLabel('|DE| Dolby')).toBe('de');
  });

  test('a code among words that are not languages', () => {
    expect(languageFromLabel('SWE 5.1')).toBe('sv');
    expect(languageFromLabel('eng - AC3 stereo')).toBe('en');
    expect(languageFromLabel('fre forced')).toBe('fr');
    expect(languageFromLabel('Commentary ENG')).toBe('en');
  });

  test('never a language from a codec, a flag or a placeholder', () => {
    expect(languageFromLabel('HE-AAC')).toBeUndefined();
    expect(languageFromLabel('English HI')).toBe('en');
    expect(languageFromLabel('HI')).toBe('hi'); // a bare code is a code
    expect(languageFromLabel('SDH HI')).toBeUndefined();
    expect(languageFromLabel('Track 1')).toBeUndefined();
    expect(languageFromLabel('Subtitles 2')).toBeUndefined();
    expect(languageFromLabel('Commentary')).toBeUndefined();
    expect(languageFromLabel('Director may comment')).toBeUndefined();
    expect(languageFromLabel('AC3 5.1')).toBeUndefined();
  });
});

describe('languageFromFileName', () => {
  test('a code part before the extension', () => {
    expect(languageFromFileName('Synthetic.Film.2020.sv.srt')).toBe('sv');
    expect(languageFromFileName('Synthetic.Film.2020.eng.forced.srt')).toBe('en');
    expect(languageFromFileName('synthetic_film_ger.vtt')).toBe('de');
    expect(languageFromFileName('Film-pt-BR.srt')).toBe('pt');
  });

  test('a language name in the file name', () => {
    expect(languageFromFileName('Synthetic Film [Swedish].srt')).toBe('sv');
    expect(languageFromFileName('Synthetic Film - Svenska.ass')).toBe('sv');
  });

  test('nothing in the name: nothing', () => {
    expect(languageFromFileName('Synthetic.Film.2020.1080p.srt')).toBeUndefined();
    expect(languageFromFileName('subs.srt')).toBeUndefined();
    expect(languageFromFileName('')).toBeUndefined();
  });

  test('words of the title are not codes', () => {
    // "it" and "is" are words here, not Italian or Icelandic: only the last part before the extension counts as a code.
    expect(languageFromFileName('What.It.Is.2020.srt')).toBeUndefined();
  });
});

describe('detectTextLanguage', () => {
  test('Latin-script languages by their common words', () => {
    expect(detectTextLanguage('I do not know what you are talking about. We have to go now, it is not safe here.')).toBe('en');
    expect(detectTextLanguage('Jag vet inte vad du pratar om. Vi måste gå nu, det är inte säkert här.')).toBe('sv');
    expect(detectTextLanguage('Ich weiß nicht, wovon du redest. Wir müssen jetzt gehen, es ist hier nicht sicher.')).toBe('de');
    expect(detectTextLanguage('Je ne sais pas de quoi tu parles. Nous devons partir maintenant, ce n\'est pas sûr ici.')).toBe('fr');
    expect(detectTextLanguage('No sé de qué estás hablando. Tenemos que irnos ahora, no es seguro aquí.')).toBe('es');
    expect(detectTextLanguage('Non so di cosa stai parlando. Dobbiamo andare adesso, non è sicuro qui.')).toBe('it');
    expect(detectTextLanguage('Não sei do que você está falando. Temos que ir agora, não é seguro aqui.')).toBe('pt');
    expect(detectTextLanguage('Ik weet niet waar je het over hebt. We moeten nu gaan, het is hier niet veilig.')).toBe('nl');
    expect(detectTextLanguage('Jeg ved ikke hvad du taler om. Vi er nødt til at gå nu, det er ikke sikkert her.')).toBe('da');
    expect(detectTextLanguage('Jeg vet ikke hva du snakker om. Vi må gå nå, det er ikke trygt her.')).toBe('no');
    expect(detectTextLanguage('En tiedä mistä puhut. Meidän täytyy lähteä nyt, täällä ei ole turvallista.')).toBe('fi');
    expect(detectTextLanguage('Nie wiem, o czym mówisz. Musimy już iść, tu nie jest bezpiecznie.')).toBe('pl');
    expect(detectTextLanguage('Neden bahsettiğini bilmiyorum. Şimdi gitmemiz lazım, burası güvenli değil.')).toBe('tr');
    expect(detectTextLanguage('Nevím, o čem mluvíš. Musíme hned jít, tady to není bezpečné.')).toBe('cs');
    expect(detectTextLanguage('Nem tudom, miről beszélsz. Most mennünk kell, itt nem biztonságos.')).toBe('hu');
    expect(detectTextLanguage('Nu știu despre ce vorbești. Trebuie să plecăm acum, nu e sigur aici.')).toBe('ro');
  });

  test('other scripts by their letters', () => {
    expect(detectTextLanguage('Я не знаю, о чём ты говоришь. Нам нужно уходить сейчас, здесь небезопасно.')).toBe('ru');
    expect(detectTextLanguage('Я не знаю, про що ти говориш. Нам треба йти зараз, тут небезпечно, їжа є.')).toBe('uk');
    expect(detectTextLanguage('لا أعرف ما الذي تتحدث عنه. علينا أن نذهب الآن، المكان هنا ليس آمنا.')).toBe('ar');
    expect(detectTextLanguage('نمی‌دانم درباره چه چیزی صحبت می‌کنی. باید همین حالا برویم، اینجا امن نیست.')).toBe('fa');
    expect(detectTextLanguage('אני לא יודע על מה אתה מדבר. אנחנו חייבים ללכת עכשיו, זה לא בטוח כאן.')).toBe('he');
    expect(detectTextLanguage('Δεν ξέρω για τι μιλάς. Πρέπει να φύγουμε τώρα, δεν είναι ασφαλές εδώ.')).toBe('el');
    expect(detectTextLanguage('何を言っているのか分からない。今すぐ行かなければならない、ここは安全じゃない。')).toBe('ja');
    expect(detectTextLanguage('무슨 말을 하는지 모르겠어. 지금 당장 가야 해, 여기는 안전하지 않아.')).toBe('ko');
    expect(detectTextLanguage('我不知道你在说什么。我们现在必须走了，这里不安全。')).toBe('zh');
    expect(detectTextLanguage('ฉันไม่รู้ว่าคุณกำลังพูดถึงอะไร เราต้องไปเดี๋ยวนี้ ที่นี่ไม่ปลอดภัย')).toBe('th');
    expect(detectTextLanguage('मुझे नहीं पता कि तुम किस बारे में बात कर रहे हो। हमें अभी जाना होगा।')).toBe('hi');
  });

  test('ignores subtitle markup and speaker tags', () => {
    expect(detectTextLanguage('<i>[MAN]</i> Jag vet inte vad du pratar om.\n<i>- Vi måste gå nu, det är inte säkert här.</i>')).toBe('sv');
  });

  test('too little text or no clear winner: nothing', () => {
    expect(detectTextLanguage('OK')).toBeUndefined();
    expect(detectTextLanguage('♪ ♪')).toBeUndefined();
    expect(detectTextLanguage('')).toBeUndefined();
    expect(detectTextLanguage('Lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor')).toBeUndefined();
  });
});
