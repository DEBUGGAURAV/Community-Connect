
import sys
import json
import re
import math
from collections import Counter

STOPWORDS = {
    'a', 'an', 'and', 'are', 'for', 'from', 'i', 'in', 'is', 'it', 'of',
    'on', 'the', 'to', 'with', 'you', 'need', 'help'
}

URGENCY_KEYWORDS = {
    'high': ['urgent', 'emergency', 'immediately', 'asap', 'critical'],
    'medium': ['soon', 'this week', 'needed'],
    'low': ['whenever', 'no rush', 'eventually'],
}

CATEGORY_KEYWORDS = {
    'food': ['food', 'meal', 'groceries', 'hungry'],
    'medical': ['medicine', 'doctor', 'health', 'injury', 'medical'],
    'shelter': ['shelter', 'housing', 'homeless', 'roof'],
    'tutoring': ['study', 'tutor', 'homework', 'exam', 'learning'],
    'transport': ['ride', 'transport', 'drive', 'pickup'],
}


def clean_text(text):
    text = text.lower()
    text = re.sub(r'[^a-z\s]', ' ', text)
    tokens = [w for w in text.split() if w not in STOPWORDS]
    return ' '.join(tokens)


def normalize_location(location):
    return re.sub(r'\s+', ' ', str(location or '').strip().lower())


def normalized_tokens(text):
    tokens = clean_text(text).split()
    return {token[:-1] if len(token) > 4 and token.endswith('s') else token for token in tokens}


def detect_category(description):
    desc = description.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(k in desc for k in keywords):
            return category
    return 'general'


def detect_urgency(description):
    desc = description.lower()
    for level, keywords in URGENCY_KEYWORDS.items():
        if any(k in desc for k in keywords):
            return level
    return 'medium'


def cosine_similarity(texts):
    token_sets = [text.split() for text in texts]
    document_frequency = Counter(token for tokens in token_sets for token in set(tokens))
    document_count = len(token_sets)
    vectors = []

    for tokens in token_sets:
        counts = Counter(tokens)
        vector = {}
        for token, count in counts.items():
            inverse_frequency = math.log((1 + document_count) / (1 + document_frequency[token])) + 1
            vector[token] = (count / len(tokens)) * inverse_frequency
        vectors.append(vector)

    request_vector = vectors[0]
    request_length = math.sqrt(sum(value * value for value in request_vector.values()))
    scores = []
    for volunteer_vector in vectors[1:]:
        volunteer_length = math.sqrt(sum(value * value for value in volunteer_vector.values()))
        if not request_length or not volunteer_length:
            scores.append(0.0)
            continue
        dot_product = sum(request_vector.get(token, 0) * value for token, value in volunteer_vector.items())
        scores.append(dot_product / (request_length * volunteer_length))
    return scores


def rank_volunteers(request, volunteers):
    description = request.get('description', '') + ' ' + request.get('helpType', '')
    category = detect_category(description)
    urgency = detect_urgency(description)

    request_text = clean_text(description + ' ' + category)
    volunteer_texts = [
        clean_text(' '.join(v.get('skills', [])) + ' ' + v.get('bio', ''))
        for v in volunteers
    ]

    if not volunteers:
        return {
            'category': category,
            'urgency': urgency,
            'matches': [],
        }

    similarities = cosine_similarity([request_text] + volunteer_texts)

    results = []
    for volunteer, score in zip(volunteers, similarities):
        same_location = normalize_location(volunteer.get('location')) == normalize_location(request.get('location'))
        location_bonus = 1.0 if same_location else 0
        final_score = float(score) + location_bonus
        results.append({
            'volunteerId': volunteer.get('_id'),
            'name': volunteer.get('name'),
            'score': round(final_score, 4),
            'location': volunteer.get('location'),
            'nearby': same_location,
        })

    results.sort(key=lambda r: r['score'], reverse=True)

    return {
        'category': category,
        'urgency': urgency,
        'matches': results[:5],  # top 5 candidates
    }


def rank_requests(volunteer, requests):
    volunteer_text = clean_text(' '.join(volunteer.get('skills', [])) + ' ' + volunteer.get('bio', ''))
    request_categories = [r.get('category') or detect_category(r.get('description', '') + ' ' + r.get('helpType', '')) for r in requests]
    request_texts = [clean_text(r.get('description', '') + ' ' + r.get('helpType', '') + ' ' + category) for r, category in zip(requests, request_categories)]
    similarities = cosine_similarity([volunteer_text] + request_texts)
    skill_tokens = normalized_tokens(' '.join(volunteer.get('skills', [])))
    results = []

    for request, category, score in zip(requests, request_categories, similarities):
        request_tokens = normalized_tokens(request.get('description', '') + ' ' + request.get('helpType', '') + ' ' + category)
        matched_skills = sorted(skill_tokens.intersection(request_tokens))
        if category != 'general' and category in skill_tokens and category not in matched_skills:
            matched_skills.append(category)
        skill_score = len(matched_skills) / max(len(skill_tokens), 1)
        results.append({
            '_id': request.get('_id'),
            'requestId': request.get('_id'),
            'requesterName': request.get('requesterName'),
            'description': request.get('description'),
            'location': request.get('location'),
            'urgency': request.get('urgency', 'medium'),
            'score': round((float(score) * 0.6) + (skill_score * 0.4), 4),
            'matchedSkills': matched_skills,
        })

    results.sort(key=lambda result: (result['urgency'] == 'high', result['score']), reverse=True)
    return {'requests': results[:10]}


def main():
    payload = json.load(sys.stdin)
    if payload.get('mode') == 'requests':
        output = rank_requests(payload['volunteer'], payload['requests'])
    else:
        output = rank_volunteers(payload['request'], payload['volunteers'])
    print(json.dumps(output))


if __name__ == '__main__':
    main()
