import { describe, expect, it } from 'vitest';
import { subtitleText } from '../src/subtitles/markup.ts';

// Synthetic cue texts written for these tests.
describe('subtitleText', () => {
  const cases: [string, string, string][] = [
    // line breaks
    ['<br> tag', 'One<br>Two', 'One\nTwo'],
    ['<BR> upper case', 'One<BR>Two', 'One\nTwo'],
    ['<Br> mixed case', 'One<Br>Two', 'One\nTwo'],
    ['<br/> self-closing', 'One<br/>Two', 'One\nTwo'],
    ['<BR /> with space', 'One<BR />Two', 'One\nTwo'],
    ['</br> stray close', 'One</br>Two', 'One\nTwo'],
    ['<br> with attributes', 'One<br class="x">Two', 'One\nTwo'],
    ['unclosed <BR at the end', 'One<BR', 'One'],
    ['unclosed <BR before a space', 'One<BR Two', 'One\nTwo'],
    ['unclosed <br before a newline', 'One<br\nTwo', 'One\nTwo'],
    ['<br> next to a newline gives one break', 'One<br>\nTwo', 'One\nTwo'],
    ['<br><br> gives one break', 'One<br><br>Two', 'One\nTwo'],
    ['ASS \\N hard break', 'One\\NTwo', 'One\nTwo'],
    ['ASS \\n soft break', 'One\\nTwo', 'One\nTwo'],
    ['ASS \\h hard space', 'One\\hTwo', 'One Two'],
    ['CRLF and CR', 'One\r\nTwo\rThree', 'One\nTwo\nThree'],
    // styling tags
    ['<i>', '<i>Hello</i>', 'Hello'],
    ['<I> upper case', '<I>Hello</I>', 'Hello'],
    ['<b> and <u>', '<b>Bold</b> <u>under</u>', 'Bold under'],
    ['<font color>', '<font color="#ffff00">Yellow</font>', 'Yellow'],
    ['<FONT face> upper case', '<FONT FACE="Arial">Text</FONT>', 'Text'],
    ['WebVTT class and voice', '<c.yellow>Col</c> <v Anna>Hi</v>', 'Col Hi'],
    ['WebVTT timestamp tag', 'One <00:00:01.500>two', 'One two'],
    ['SAMI <P> and <SYNC>', '<SYNC Start=1000><P Class=ENCC>Hello', 'Hello'],
    ['unclosed <i at the end', 'Hello<i', 'Hello'],
    ['unclosed <font at the end', 'Hello <font color="red"', 'Hello'],
    ['unclosed </i at a line end', 'Hello</i\nNext', 'Hello\nNext'],
    ['a tag spanning lines', '<font\ncolor="red">Red</font>', 'Red'],
    // ASS override blocks
    ['{\\an8}', '{\\an8}Top', 'Top'],
    ['{\\i1}...{\\i0}', '{\\i1}Ital{\\i0}ic', 'Italic'],
    ['several overrides', '{\\pos(10,20)\\c&H00FFFF&}Moved', 'Moved'],
    ['unclosed override at the end', 'Text{\\an8', 'Text'],
    ['plain braces stay', 'Set {a, b}', 'Set {a, b}'],
    // entities
    ['&amp; &lt; &gt;', 'A &amp; B &lt;3 &gt;', 'A & B <3 >'],
    ['&nbsp;', 'A&nbsp;B', 'A B'],
    ['&NBSP; upper case', 'A&NBSP;B', 'A B'],
    ['&quot; &apos;', '&quot;Hi&apos;', '"Hi\''],
    ['decimal entity', 'caf&#233;', 'café'],
    ['hex entity', 'caf&#xE9;', 'café'],
    ['invalid numeric entity stays', 'x&#99999999;y', 'x&#99999999;y'],
    ['unknown entity stays', 'Tom &foo; Jerry', 'Tom &foo; Jerry'],
    ['entity-encoded tag stays as text', '&lt;i&gt;', '<i>'],
    ['&lrm; dropped', 'A&lrm;B', 'AB'],
    // plain text kept
    ['less-than in text', 'a < b and 3<4', 'a < b and 3<4'],
    ['ampersand in text', 'Tom & Jerry', 'Tom & Jerry'],
    ['backslash in text', 'C:\\Path', 'C:\\Path'],
    // whitespace
    ['runs of spaces collapse', '  A   B  ', 'A B'],
    ['blank lines drop', 'A\n\n  \nB', 'A\nB'],
    ['only markup is empty', ' <i></i> {\\an8} <br> ', ''],
    ['empty', '', ''],
  ];
  it.each(cases)('%s', (_name, input, want) => {
    expect(subtitleText(input)).toBe(want);
  });
});
