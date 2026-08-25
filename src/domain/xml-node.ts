/** A small, transport-independent lossless representation of XML. */
export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlText {
  type: "text";
  text: string;
}

export interface XmlComment {
  type: "comment";
  text: string;
}

/**
 * Attributes are kept as an ordered list as well as a convenient map.  The
 * map is optional on purpose: parsers can retain duplicate/odd source
 * attributes in `attributes` without normalising them away.
 */
export interface XmlElement {
  type?: "element";
  name: string;
  attributes?: Record<string, string>;
  attributeList?: XmlAttribute[];
  children?: XmlNode[];
}

export type XmlNode = XmlElement | XmlText | XmlComment;

export const isXmlElement = (node: XmlNode): node is XmlElement =>
  node.type === undefined || node.type === "element";
