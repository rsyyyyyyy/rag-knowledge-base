import json
import tempfile
from pathlib import Path
from unittest import TestCase

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

from evidence_grounding import quote_span
from pdf_evidence import extract_pdf_chunks, token_count, PARSER_VERSION, _line_map


def layout_pdf(path, lines, graphics='', rotate=0):
    writer = PdfWriter()
    writer.add_blank_page(650, 800)
    page = writer.pages[-1]
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({
        NameObject('/F1'): DictionaryObject({NameObject('/Type'): NameObject('/Font'),
            NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})})})
    commands = [graphics]
    for x, y, size, text in lines:
        text = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        commands.append(f'BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET')
    stream = DecodedStreamObject()
    stream.set_data('\n'.join(commands).encode('ascii'))
    page[NameObject('/Contents')] = writer._add_object(stream)
    if rotate: page.rotate(rotate)
    with path.open('wb') as output: writer.write(output)


class PdfStructureTest(TestCase):
    def test_ligatures_align_exactly_and_other_mismatches_degrade_to_line(self):
        chars=[{'text':text,'x0':index*6,'x1':(index+1)*6,'top':10,'bottom':20}
               for index,text in enumerate(['\ufb01','n','e',' ','r','e','s','u','l','t'])]
        line={'chars':chars}
        mapping=_line_map(line,'fine result',(0,0,100,100),0)
        self.assertEqual(len(mapping['words']),2)
        self.assertEqual(mapping['words'][0]['end'],4)
        self.assertTrue(all(w['mapped'] for w in mapping['words']))
        broken=_line_map(line,'fine MISSING result',(0,0,100,100),0)
        self.assertEqual(broken['words'],[])

    def test_two_columns_read_in_order_without_single_line_fragments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'columns.pdf'
            lines = [(50, 750, 16, '1 Introduction')]
            lines += [(50, 700-i*14, 10, f'LEFT line {i:02d} discusses context and method.') for i in range(14)]
            lines += [(350, 700-i*14, 10, f'RIGHT line {i:02d} discusses results and limits.') for i in range(14)]
            layout_pdf(path, lines)
            chunks = list(extract_pdf_chunks(path))
            text = '\n'.join(t for t, _ in chunks)
            self.assertLess(text.index('LEFT line 13'), text.index('RIGHT line 00'))
            self.assertLess(len(chunks), 10)
            self.assertTrue(all(meta['parser_version'] == PARSER_VERSION for _, meta in chunks))
            self.assertTrue(all(token_count(t) <= 384 for t, _ in chunks))
            for i in range(14):
                self.assertEqual(text.count(f'LEFT line {i:02d}'), 1)
                self.assertEqual(text.count(f'RIGHT line {i:02d}'), 1)

    def test_budgeted_split_keeps_tail_and_every_character(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'long.pdf'
            lines = [(50, 700-i*14, 10, f'Paragraph line {i:02d} includes unique marker value{i:04d}.') for i in range(12)]
            layout_pdf(path, lines)
            chunks = list(extract_pdf_chunks(path, chunk_size=32))
            actual = ''.join(''.join(t.split()) for t, _ in chunks)
            expected = ''.join(''.join(line[3].split()) for line in lines)
            self.assertEqual(actual, expected)
            self.assertGreater(len(chunks), 1)
            self.assertTrue(all(token_count(t) <= 32 for t, _ in chunks))

    def test_table_keeps_header_and_separates_from_body(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'table.pdf'
            graphics = '\n'.join(f'{x} 460 m {x} 520 l S' for x in (50, 150, 250))
            graphics += '\n'+'\n'.join(f'50 {y} m 250 {y} l S' for y in (460, 480, 500, 520))
            lines = [(50, 700, 10, 'The experiment controls battery temperature.'),
                     (60, 506, 10, 'Metric'), (160, 506, 10, 'Value'),
                     (60, 486, 10, 'Duration'), (160, 486, 10, '37 hours'),
                     (60, 466, 10, 'Voltage'), (160, 466, 10, '5 volts')]
            layout_pdf(path, lines, graphics)
            chunks = list(extract_pdf_chunks(path))
            table = [(text, meta) for text, meta in chunks
                     if any(e['kind'] == 'table' for e in json.loads(meta['elements_json']))]
            self.assertEqual(len(table), 1)
            self.assertIn('Metric', table[0][0])
            self.assertIn('37 hours', table[0][0])
            self.assertNotIn('experiment', table[0][0])

    def test_quote_resolves_only_supporting_words_in_rotated_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            for rotation in (0, 90, 180, 270):
                path = Path(directory)/f'quote{rotation}.pdf'
                layout_pdf(path, [(50, 700, 12, 'Battery duration was exactly 37 hours under controlled conditions.')], rotate=rotation)
                text, meta = next(extract_pdf_chunks(path))
                original = {'id':'paper', 'filename':'quote.pdf', 'chunk_id':'one',
                            'version_id':'v1', 'document_version_id':'v1', 'excerpt':text,
                            'page_index':0, 'text_sha256':meta['text_sha256'],
                            'source_map':json.loads(meta['source_map_json']),
                            'elements':json.loads(meta['elements_json']),
                            'rects':json.loads(meta['rects_json'])}
                quote = quote_span(original, 'exactly 37 hours')
                self.assertIsNotNone(quote, rotation)
                self.assertEqual(quote['excerpt'], 'exactly 37 hours')
                self.assertEqual(quote['citation_precision'], 'quote')
                self.assertEqual(len(quote['rects']), 3)
                self.assertTrue(quote['element_refs'])
                self.assertTrue(all(0 <= v <= 1 for r in quote['rects'] for v in r))
                self.assertLess(sum((r[2]-r[0])*(r[3]-r[1]) for r in quote['rects']),
                                sum((r[2]-r[0])*(r[3]-r[1]) for r in original['rects']))
